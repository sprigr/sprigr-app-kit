/**
 * In-memory D1Like mock used by pending-oauth tests.
 *
 * Implements just enough of D1Like to round-trip the SQL the
 * pending-oauth package emits:
 *   INSERT INTO <t> (csrf, payload, created_at) VALUES (?, ?, ?)
 *     ON CONFLICT(csrf) DO UPDATE SET payload = excluded.payload,
 *                                     created_at = excluded.created_at
 *   SELECT payload, created_at FROM <t> WHERE csrf = ?
 *   DELETE FROM <t> WHERE csrf = ?
 *   DELETE FROM <t> WHERE created_at < ?
 *
 * and the completion-marker SQL (./src/completions.ts):
 *   INSERT INTO <t> (csrf_hash, completed_at) VALUES (?, ?)
 *     ON CONFLICT(csrf_hash) DO UPDATE SET completed_at = excluded.completed_at
 *   SELECT completed_at FROM <t> WHERE csrf_hash = ?
 *   DELETE FROM <t> WHERE completed_at < ?
 *
 * The statement matchers are anchored on the full normalised SQL, so a
 * reflow of the emitted text fails loudly here instead of silently
 * changing what the app test suites regex-match on.
 *
 * Keys are matched literally; nothing is escaped. The mock is for unit
 * tests of pending-oauth only.
 */

import type { D1Like, D1PreparedStatementLike } from '../src/types';

export interface PendingRow {
  payload: string;
  created_at: number;
}
export type TableState = Record<string, PendingRow>;
export type DbState = Record<string, TableState>;

export interface CompletionRow {
  completed_at: number;
}
/** table -> csrf_hash -> row. Kept apart from DbState so a completions
 *  table can never be read through the pending-row matchers. */
export type CompletionState = Record<string, Record<string, CompletionRow>>;

export interface MockD1 {
  db: D1Like;
  state: DbState;
  /** Rows currently in `table`, for assertions. */
  rows(table: string): TableState;
  /** Completion markers currently in `table`, keyed by csrf_hash. */
  completionRows(table: string): Record<string, CompletionRow>;
  /** SQL statements executed, normalised to single spaces. */
  log: string[];
}

export function makeMockD1(initial: DbState = {}): MockD1 {
  const state: DbState = {};
  for (const [t, rows] of Object.entries(initial)) {
    state[t] = { ...rows };
  }
  const completions: CompletionState = {};
  const log: string[] = [];
  const db: D1Like = {
    prepare(sql: string): D1PreparedStatementLike {
      return makeStmt(sql, [], state, completions, log);
    },
  };
  return {
    db,
    state,
    log,
    rows: (table) => ensure(state, table),
    completionRows: (table) => ensure(completions, table),
  };
}

function makeStmt(
  sql: string,
  args: unknown[],
  state: DbState,
  completions: CompletionState,
  log: string[],
): D1PreparedStatementLike {
  return {
    bind(...next: unknown[]): D1PreparedStatementLike {
      return makeStmt(sql, [...args, ...next], state, completions, log);
    },
    async run() {
      execStatement(sql, args, state, completions, log);
      return {};
    },
    async first<T = unknown>(): Promise<T | null> {
      return execStatement(sql, args, state, completions, log) as T | null;
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      const result = execStatement(sql, args, state, completions, log);
      const arr = Array.isArray(result) ? result : result == null ? [] : [result];
      return { results: arr as T[] };
    },
  };
}

const INSERT_UPSERT_RX =
  /^INSERT INTO (\w+) \(csrf, payload, created_at\) VALUES \(\?, \?, \?\) ON CONFLICT\(csrf\) DO UPDATE SET payload = excluded\.payload, created_at = excluded\.created_at$/;
const SELECT_RX = /^SELECT payload, created_at FROM (\w+) WHERE csrf = \?$/;
const DELETE_ONE_RX = /^DELETE FROM (\w+) WHERE csrf = \?$/;
const DELETE_OLD_RX = /^DELETE FROM (\w+) WHERE created_at < \?$/;

const COMPLETION_UPSERT_RX =
  /^INSERT INTO (\w+) \(csrf_hash, completed_at\) VALUES \(\?, \?\) ON CONFLICT\(csrf_hash\) DO UPDATE SET completed_at = excluded\.completed_at$/;
const COMPLETION_SELECT_RX = /^SELECT completed_at FROM (\w+) WHERE csrf_hash = \?$/;
const COMPLETION_DELETE_OLD_RX = /^DELETE FROM (\w+) WHERE completed_at < \?$/;

function execStatement(
  sql: string,
  args: unknown[],
  state: DbState,
  completions: CompletionState,
  log: string[],
): unknown {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  log.push(normalized);

  const ins = INSERT_UPSERT_RX.exec(normalized);
  if (ins) {
    const rows = ensure(state, ins[1] as string);
    rows[String(args[0])] = {
      payload: String(args[1]),
      created_at: args[2] as number,
    };
    return null;
  }

  const sel = SELECT_RX.exec(normalized);
  if (sel) {
    const rows = ensure(state, sel[1] as string);
    return rows[String(args[0])] ?? null;
  }

  const delOne = DELETE_ONE_RX.exec(normalized);
  if (delOne) {
    const rows = ensure(state, delOne[1] as string);
    delete rows[String(args[0])];
    return null;
  }

  const delOld = DELETE_OLD_RX.exec(normalized);
  if (delOld) {
    const rows = ensure(state, delOld[1] as string);
    const cutoff = args[0] as number;
    for (const [csrf, row] of Object.entries(rows)) {
      if (row.created_at < cutoff) delete rows[csrf];
    }
    return null;
  }

  const cIns = COMPLETION_UPSERT_RX.exec(normalized);
  if (cIns) {
    const rows = ensure(completions, cIns[1] as string);
    rows[String(args[0])] = { completed_at: args[1] as number };
    return null;
  }

  const cSel = COMPLETION_SELECT_RX.exec(normalized);
  if (cSel) {
    const rows = ensure(completions, cSel[1] as string);
    return rows[String(args[0])] ?? null;
  }

  const cDelOld = COMPLETION_DELETE_OLD_RX.exec(normalized);
  if (cDelOld) {
    const rows = ensure(completions, cDelOld[1] as string);
    const cutoff = args[0] as number;
    for (const [hash, row] of Object.entries(rows)) {
      if (row.completed_at < cutoff) delete rows[hash];
    }
    return null;
  }

  throw new Error(`mock-d1: unhandled SQL "${normalized}"`);
}

function ensure<R>(state: Record<string, Record<string, R>>, table: string): Record<string, R> {
  if (!state[table]) state[table] = {};
  return state[table]!;
}

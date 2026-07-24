/**
 * In-memory D1Like mock used by d1-kv tests.
 *
 * Implements just enough of D1Like to round-trip the SQL the d1-kv
 * package emits:
 *   SELECT value FROM <t> WHERE key = ?
 *   INSERT INTO <t> (key, value, updated_at) VALUES (?, ?, datetime('now'))
 *     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
 *   DELETE FROM <t> WHERE key = ?
 *   SELECT key, value FROM <t>
 *
 * Keys are matched literally; nothing is escaped. The mock is for unit
 * tests of d1-kv only.
 */

import type { D1Like, D1PreparedStatementLike } from '../src/types';

export type TableState = Record<string, string>;
export type DbState = Record<string, TableState>;

export function makeMockD1(initial: DbState = {}): D1Like {
  const state: DbState = {};
  for (const [t, rows] of Object.entries(initial)) {
    state[t] = { ...rows };
  }
  return {
    prepare(sql: string): D1PreparedStatementLike {
      return makeStmt(sql, [], state);
    },
  };
}

function makeStmt(sql: string, args: unknown[], state: DbState): D1PreparedStatementLike {
  return {
    bind(...next: unknown[]): D1PreparedStatementLike {
      return makeStmt(sql, [...args, ...next], state);
    },
    async run() {
      execStatement(sql, args, state);
      return {};
    },
    async first<T = unknown>(): Promise<T | null> {
      return execStatement(sql, args, state) as T | null;
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      const result = execStatement(sql, args, state);
      const arr = Array.isArray(result) ? result : result == null ? [] : [result];
      return { results: arr as T[] };
    },
  };
}

const SELECT_VALUE_RX = /^SELECT value FROM (\w+) WHERE key = \?$/;
const INSERT_UPSERT_RX = /^INSERT INTO (\w+) \(key, value, updated_at\)\s+VALUES \(\?, \?, datetime\('now'\)\)\s+ON CONFLICT\(key\) DO UPDATE SET\s+value = excluded\.value,\s+updated_at = datetime\('now'\)$/;
const DELETE_RX = /^DELETE FROM (\w+) WHERE key = \?$/;
const SELECT_ALL_RX = /^SELECT key, value FROM (\w+)$/;

function execStatement(sql: string, args: unknown[], state: DbState): unknown {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  const sel = SELECT_VALUE_RX.exec(normalized);
  if (sel) {
    const table = sel[1] as string;
    const rows = ensure(state, table);
    const v = rows[String(args[0])];
    return v == null ? null : { value: v };
  }

  const ins = INSERT_UPSERT_RX.exec(normalized);
  if (ins) {
    const table = ins[1] as string;
    const rows = ensure(state, table);
    rows[String(args[0])] = String(args[1]);
    return null;
  }

  const del = DELETE_RX.exec(normalized);
  if (del) {
    const table = del[1] as string;
    const rows = ensure(state, table);
    delete rows[String(args[0])];
    return null;
  }

  const all = SELECT_ALL_RX.exec(normalized);
  if (all) {
    const table = all[1] as string;
    const rows = ensure(state, table);
    return Object.entries(rows).map(([key, value]) => ({ key, value }));
  }

  throw new Error(`mock-d1: unhandled SQL "${normalized}"`);
}

function ensure(state: DbState, table: string): TableState {
  if (!state[table]) state[table] = {};
  return state[table]!;
}

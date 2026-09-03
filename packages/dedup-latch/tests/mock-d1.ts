/**
 * In-memory D1Like mock with row-tracking (so we can simulate
 * `INSERT OR IGNORE` semantics + `meta.changes` accurately).
 */

import type { D1Like, D1PreparedStatementLike, D1RunResult } from '../src/types';

export interface MockState {
  rows: Map<string, { claimed_at: string; expires_at: string }>;
}

export function makeMockD1(initial: Array<[string, { expires_at: string }]> = []): {
  db: D1Like;
  state: MockState;
} {
  const state: MockState = { rows: new Map() };
  for (const [id, row] of initial) {
    state.rows.set(id, { claimed_at: new Date(0).toISOString(), expires_at: row.expires_at });
  }
  return { db: makeDb(state), state };
}

function makeDb(state: MockState): D1Like {
  return {
    prepare(sql: string): D1PreparedStatementLike {
      return makeStmt(sql, [], state);
    },
  };
}

function makeStmt(sql: string, args: unknown[], state: MockState): D1PreparedStatementLike {
  return {
    bind(...next: unknown[]): D1PreparedStatementLike {
      return makeStmt(sql, [...args, ...next], state);
    },
    async run(): Promise<D1RunResult> {
      return execStatement(sql, args, state);
    },
    async first<T = unknown>(): Promise<T | null> {
      return null;
    },
  };
}

const INSERT_RX =
  /^INSERT INTO (\w+) \(id, claimed_at, expires_at\)\s+VALUES \(\?, datetime\('now'\), \?\)\s+ON CONFLICT\(id\) DO NOTHING$/;
/**
 * Either spelling of "now" is accepted, and the mock then compares the way
 * SQLite does: as TEXT, against "now" rendered in THAT expression's format.
 * `datetime('now')` is `YYYY-MM-DD HH:MM:SS`; the strftime form is ISO with
 * milliseconds, identical to what tryClaim writes. A `Date.parse` compare
 * here would hide the exact bug the ISO form fixes.
 */
const DELETE_EXPIRED_RX =
  /^DELETE FROM (\w+) WHERE expires_at <= (datetime\('now'\)|strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\))$/;

/** Render "now" the way the given SQLite expression would. */
export function sqliteNow(expression: string): string {
  const iso = new Date().toISOString();
  return expression.startsWith('strftime') ? iso : iso.slice(0, 19).replace('T', ' ');
}

function execStatement(sql: string, args: unknown[], state: MockState): D1RunResult {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  const ins = INSERT_RX.exec(normalized);
  if (ins) {
    const id = String(args[0]);
    const expiresAt = String(args[1]);
    if (state.rows.has(id)) {
      return { meta: { changes: 0 } };
    }
    state.rows.set(id, { claimed_at: new Date().toISOString(), expires_at: expiresAt });
    return { meta: { changes: 1 } };
  }

  const del = DELETE_EXPIRED_RX.exec(normalized);
  if (del) {
    const now = sqliteNow(del[2]!);
    let deleted = 0;
    for (const [id, row] of state.rows) {
      // TEXT comparison, byte-wise, exactly as SQLite does it.
      if (row.expires_at <= now) {
        state.rows.delete(id);
        deleted += 1;
      }
    }
    return { meta: { changes: deleted } };
  }

  throw new Error(`mock-d1: unhandled SQL "${normalized}"`);
}

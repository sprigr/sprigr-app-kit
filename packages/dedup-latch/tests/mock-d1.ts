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
const DELETE_EXPIRED_RX = /^DELETE FROM (\w+) WHERE expires_at <= datetime\('now'\)$/;

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

  if (DELETE_EXPIRED_RX.test(normalized)) {
    const now = Date.now();
    let deleted = 0;
    for (const [id, row] of state.rows) {
      if (Date.parse(row.expires_at) <= now) {
        state.rows.delete(id);
        deleted += 1;
      }
    }
    return { meta: { changes: deleted } };
  }

  throw new Error(`mock-d1: unhandled SQL "${normalized}"`);
}

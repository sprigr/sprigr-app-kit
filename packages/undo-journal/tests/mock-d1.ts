/**
 * In-memory D1Like mock. Tracks rows so TTL sweeps and delete-by-ref can be
 * asserted, and can be told to throw on a chosen statement so the
 * degrade-rather-than-fail paths get exercised for real.
 */

import type { D1Like, D1PreparedStatementLike } from '../src/types';

export interface JournalRecord {
  ref: string;
  entity: string;
  original_id: string;
  connection: string | null;
  before_json: string;
  created_at: number;
  expires_at: number;
}

export interface MockState {
  rows: Map<string, JournalRecord>;
  /** SQL fragments that should make prepare().run()/first() throw. */
  failOn: string[];
  /** Every SQL string the caller prepared, in order. */
  sql: string[];
}

export function makeMockD1(initial: JournalRecord[] = []): { db: D1Like; state: MockState } {
  const state: MockState = { rows: new Map(), failOn: [], sql: [] };
  for (const r of initial) state.rows.set(r.ref, r);
  return { db: makeDb(state), state };
}

function makeDb(state: MockState): D1Like {
  return {
    prepare(sql: string): D1PreparedStatementLike {
      state.sql.push(sql);
      let args: unknown[] = [];
      const stmt: D1PreparedStatementLike = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async run() {
          maybeThrow(state, sql);
          if (/^\s*INSERT INTO/i.test(sql)) {
            const [ref, entity, original_id, connection, before_json, created_at, expires_at] =
              args as [string, string, string, string | null, string, number, number];
            if (state.rows.has(ref)) throw new Error('UNIQUE constraint failed');
            state.rows.set(ref, {
              ref,
              entity,
              original_id,
              connection,
              before_json,
              created_at,
              expires_at,
            });
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM .* WHERE expires_at </i.test(sql)) {
            const now = args[0] as number;
            let n = 0;
            for (const [k, v] of [...state.rows]) {
              if (v.expires_at < now) {
                state.rows.delete(k);
                n++;
              }
            }
            return { meta: { changes: n } };
          }
          if (/DELETE FROM .* WHERE ref =/i.test(sql)) {
            const changed = state.rows.delete(args[0] as string) ? 1 : 0;
            return { meta: { changes: changed } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>() {
          maybeThrow(state, sql);
          const row = state.rows.get(args[0] as string);
          if (!row) return null;
          return {
            entity: row.entity,
            original_id: row.original_id,
            connection: row.connection,
            before_json: row.before_json,
          } as T;
        },
      };
      return stmt;
    },
  };
}

function maybeThrow(state: MockState, sql: string): void {
  for (const frag of state.failOn) {
    if (sql.includes(frag)) throw new Error(`mock D1 failure on: ${frag}`);
  }
}

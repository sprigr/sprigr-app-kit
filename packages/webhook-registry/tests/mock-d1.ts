/**
 * In-memory D1 mock for webhook-registry tests.
 */

import type { D1Like, D1PreparedStatementLike } from '../src/types';

export interface MockRow {
  topic: string;
  subscription_id: string;
  callback_url: string;
  registered_at: string;
}

export interface MockState {
  rows: Map<string, MockRow>;
}

export function makeMockD1(initial: MockRow[] = []): { db: D1Like; state: MockState } {
  const state: MockState = { rows: new Map() };
  for (const r of initial) state.rows.set(r.topic, { ...r });
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

const LIST_RX =
  /^SELECT topic, subscription_id AS subscriptionId, callback_url AS callbackUrl, registered_at AS registeredAt FROM (\w+) ORDER BY topic$/;
const FIND_RX =
  /^SELECT topic, subscription_id AS subscriptionId, callback_url AS callbackUrl, registered_at AS registeredAt FROM (\w+) WHERE topic = \?$/;
const UPSERT_RX =
  /^INSERT INTO (\w+) \(topic, subscription_id, callback_url, registered_at\)\s+VALUES \(\?, \?, \?, datetime\('now'\)\)\s+ON CONFLICT\(topic\) DO UPDATE SET\s+subscription_id = excluded\.subscription_id,\s+callback_url = excluded\.callback_url,\s+registered_at = datetime\('now'\)$/;
const DELETE_RX = /^DELETE FROM (\w+) WHERE topic = \?$/;

function execStatement(sql: string, args: unknown[], state: MockState): unknown {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  const listMatch = LIST_RX.exec(normalized);
  if (listMatch) {
    const table = listMatch[1] as string;
    const rows = Array.from(state.rows.entries())
      .filter(([k]) => k.startsWith(`${table}:`))
      .map(([, r]) => r)
      .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
      .map(toRecord);
    return rows;
  }

  const findMatch = FIND_RX.exec(normalized);
  if (findMatch) {
    const table = findMatch[1] as string;
    const topic = String(args[0]);
    const row = state.rows.get(`${table}:${topic}`);
    return row ? toRecord(row) : null;
  }

  const upsertMatch = UPSERT_RX.exec(normalized);
  if (upsertMatch) {
    const table = upsertMatch[1] as string;
    state.rows.set(`${table}:${String(args[0])}`, {
      topic: String(args[0]),
      subscription_id: String(args[1]),
      callback_url: String(args[2]),
      registered_at: new Date().toISOString(),
    });
    return null;
  }

  const deleteMatch = DELETE_RX.exec(normalized);
  if (deleteMatch) {
    const table = deleteMatch[1] as string;
    state.rows.delete(`${table}:${String(args[0])}`);
    return null;
  }

  throw new Error(`mock-d1: unhandled SQL "${normalized}"`);
}

function toRecord(r: MockRow) {
  return {
    topic: r.topic,
    subscriptionId: r.subscription_id,
    callbackUrl: r.callback_url,
    registeredAt: r.registered_at,
  };
}

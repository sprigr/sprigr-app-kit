/**
 * In-memory D1 for the vendor simulator tests: one install's database.
 *
 * Implements only the statements the sample store emits, on one table shape
 * `(resource TEXT, id TEXT, body TEXT, deleted INTEGER, PRIMARY KEY (resource, id))`:
 *   SELECT id FROM <t> WHERE resource = ? AND id = ?
 *   SELECT id, body, deleted FROM <t> WHERE resource = ?
 *   INSERT INTO <t> (resource, id, body, deleted) VALUES (?, ?, ?, ?)
 *     ON CONFLICT(resource, id) DO NOTHING
 *   INSERT INTO <t> (resource, id, body, deleted) VALUES (?, ?, ?, ?)
 *     ON CONFLICT(resource, id) DO UPDATE SET body = excluded.body, deleted = excluded.deleted
 *   DELETE FROM <t>
 * Any other statement throws, so a store that drifts from this list fails loudly.
 *
 * `failOn` makes every statement whose normalised SQL matches it throw, to stand
 * in for a D1 error. `statements` records each statement run, for read counts.
 */

export interface Row {
  resource: string;
  id: string;
  body: string;
  deleted: number;
}

export interface MockD1 {
  db: D1Database;
  rows: Map<string, Row>;
  statements: string[];
  failOn: RegExp | null;
}

const key = (resource: string, id: string) => `${resource}\u0000${id}`;

export function makeMockD1(table: string, seed: Row[] = []): MockD1 {
  const mock: MockD1 = { db: null as unknown as D1Database, rows: new Map(), statements: [], failOn: null };
  for (const r of seed) mock.rows.set(key(r.resource, r.id), { ...r });

  const exec = (sql: string, args: unknown[]): unknown => {
    const s = sql.replace(/\s+/g, ' ').trim();
    mock.statements.push(s);
    if (mock.failOn && mock.failOn.test(s)) throw new Error('D1_ERROR: injected failure');
    const t = table;
    if (s === `SELECT id FROM ${t} WHERE resource = ? AND id = ?`) {
      const r = mock.rows.get(key(String(args[0]), String(args[1])));
      return r ? [{ id: r.id }] : [];
    }
    if (s === `SELECT id, body, deleted FROM ${t} WHERE resource = ?`) {
      return [...mock.rows.values()]
        .filter((r) => r.resource === String(args[0]))
        .map((r) => ({ id: r.id, body: r.body, deleted: r.deleted }));
    }
    const insert = `INSERT INTO ${t} (resource, id, body, deleted) VALUES (?, ?, ?, ?) ON CONFLICT(resource, id)`;
    if (s === `${insert} DO NOTHING`) {
      const k = key(String(args[0]), String(args[1]));
      if (!mock.rows.has(k)) mock.rows.set(k, { resource: String(args[0]), id: String(args[1]), body: String(args[2]), deleted: Number(args[3]) });
      return [];
    }
    if (s === `${insert} DO UPDATE SET body = excluded.body, deleted = excluded.deleted`) {
      mock.rows.set(key(String(args[0]), String(args[1])), { resource: String(args[0]), id: String(args[1]), body: String(args[2]), deleted: Number(args[3]) });
      return [];
    }
    if (s === `DELETE FROM ${t}`) {
      mock.rows.clear();
      return [];
    }
    throw new Error(`mock-d1: unexpected statement: ${s}`);
  };

  const stmt = (sql: string, args: unknown[]): D1PreparedStatement => {
    const self = {
      bind: (...next: unknown[]) => stmt(sql, [...args, ...next]),
      first: async () => (exec(sql, args) as unknown[])[0] ?? null,
      all: async () => ({ results: exec(sql, args) as unknown[], success: true, meta: {} }),
      run: async () => {
        exec(sql, args);
        return { results: [], success: true, meta: {} };
      },
      raw: async () => {
        throw new Error('mock-d1: raw is not supported');
      },
    };
    return self as unknown as D1PreparedStatement;
  };

  mock.db = { prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database;
  return mock;
}

/**
 * A D1Like over a real SQLite engine (sql.js, WASM, so it runs on the Node 20
 * the CI uses). A mock cannot test a query; this runs the store's actual SQL
 * against the apps' actual schemas.
 */
import initSqlJs from 'sql.js';
import type { D1Like } from '@sprigr/apps-app-sdk';

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

export interface SqliteD1 extends D1Like {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[];
}

export async function makeSqliteD1(schema: string): Promise<SqliteD1> {
  sqlPromise ??= initSqlJs();
  const SQL = await sqlPromise;
  const db = new SQL.Database();
  db.exec(schema);
  const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  function rows(sql: string, binds: unknown[]): Record<string, unknown>[] {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(binds.map(norm));
      const out: Record<string, unknown>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }
  const d1: SqliteD1 = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          rows(sql, binds);
          return { meta: { changes: db.getRowsModified() } };
        },
        async first<T>() {
          return (rows(sql, binds)[0] as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: rows(sql, binds) as T[] };
        },
      };
      return stmt;
    },
    exec(sql: string) {
      db.exec(sql);
    },
    all<T>(sql: string, ...binds: unknown[]) {
      return rows(sql, binds) as T[];
    },
  };
  return d1;
}

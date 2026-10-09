/**
 * The two fakes behind the "a Home read changes nothing" checks.
 *
 *  - `trackD1(db)` wraps a D1 binding and records every statement that writes
 *    (INSERT, UPDATE, DELETE, REPLACE, UPSERT, CREATE, DROP, ALTER), whichever
 *    way it runs: `prepare(...).run|all|first|raw`, `batch` or `exec`. The
 *    statement still runs, so the app behaves as it would; the harness only
 *    counts.
 *  - `readOnlySprigr(sprigr)` wraps `env.SPRIGR` the way the platform's wrapper
 *    does on a Home dispatch (sprigr-team decision 0177): the reads it lists
 *    pass through, and any other method is refused with `home_read_only` and
 *    recorded. The list mirrors `HOME_DISPATCH_READ_METHODS` in sprigr-team
 *    `containers/build-runner/entrypoint/adapters/sprigr-wrapper-home.ts`.
 */

/** The `env.SPRIGR` methods a Home dispatch may call (decision 0177). */
export const HOME_DISPATCH_READ_METHODS: readonly string[] = [
  'data.search',
  'data.get',
  'data.listIds',
  'collections.query',
  'collections.describe',
  'collections.history',
  'store.get',
  'store.list',
  'files.get',
  'files.list',
  'files.job',
  'jobs.get',
  'jobs.list',
  'grants.providers',
  'fulfillment_services.list',
  'connect.checkAgentBind',
];

const WRITE_SQL = /^\s*(insert|update|delete|replace|upsert|create|drop|alter)\b/i;

/** True when `v` looks like a D1 binding. */
export function isD1Like(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { prepare?: unknown }).prepare === 'function'
    && typeof (v as { batch?: unknown }).batch === 'function';
}

export interface D1Tracker<T> {
  db: T;
  /** The SQL of every write that ran, in order. */
  readonly writes: string[];
}

export function trackD1<T extends object>(db: T): D1Tracker<T> {
  const writes: string[] = [];
  const note = (sql: unknown) => {
    if (typeof sql === 'string' && WRITE_SQL.test(sql)) writes.push(sql.trim().replace(/\s+/g, ' ').slice(0, 120));
  };
  const wrapStmt = (stmt: object, sql: string): object => new Proxy(stmt, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== 'function') return v;
      if (prop === 'bind') return (...a: unknown[]) => wrapStmt((v as (...x: unknown[]) => object).apply(target, a), sql);
      if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
        return (...a: unknown[]) => { note(sql); return (v as (...x: unknown[]) => unknown).apply(target, a); };
      }
      return (v as (...x: unknown[]) => unknown).bind(target);
    },
  });
  const sqlOf = new WeakMap<object, string>();
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== 'function') return v;
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = (v as (s: string) => object).call(target, sql);
          const wrapped = wrapStmt(stmt, sql);
          sqlOf.set(wrapped, sql);
          return wrapped;
        };
      }
      if (prop === 'batch') {
        return (stmts: object[]) => {
          for (const s of stmts) note(sqlOf.get(s));
          return (v as (s: object[]) => unknown).call(target, stmts);
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          for (const part of String(sql).split(';')) note(part);
          return (v as (s: string) => unknown).call(target, sql);
        };
      }
      return (v as (...x: unknown[]) => unknown).bind(target);
    },
  });
  return { db: proxy as T, writes };
}

export interface SprigrTracker<T> {
  sprigr: T;
  /** Every method a Home dispatch may not call, by dotted name, in order. */
  readonly refused: string[];
}

export function readOnlySprigr<T extends object>(sprigr: T): SprigrTracker<T> {
  const refused: string[] = [];
  const wrap = (target: object, path: string): object => new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      const name = path ? `${path}.${String(prop)}` : String(prop);
      if (typeof v === 'function') {
        if (HOME_DISPATCH_READ_METHODS.includes(name)) return (v as (...a: unknown[]) => unknown).bind(t);
        return (..._a: unknown[]) => {
          refused.push(name);
          const err = new Error(`home_read_only: ${name} is not allowed on a Home dispatch`) as Error & { code: string };
          err.code = 'home_read_only';
          return Promise.reject(err);
        };
      }
      if (v && typeof v === 'object') return wrap(v as object, name);
      return v;
    },
  });
  return { sprigr: wrap(sprigr, '') as T, refused };
}

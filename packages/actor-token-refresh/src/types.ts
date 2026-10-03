/**
 * D1 binding shape the durable refresh lease needs. Declared structurally
 * so the package has no runtime or type dependencies, and still works when
 * an app mirrors its source instead of installing it (a source mirror does
 * not install dependencies, so this package must not import a type from
 * another package).
 *
 * Deliberately the same shape `@sprigr/apps-dedup-latch` declares, so a
 * caller can hand the same `env.DB` to both without TypeScript arguing
 * about `run()` return types.
 */
export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...args: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
}

/**
 * The subset of D1Result we read. `run()` is `Promise<unknown>` for
 * cross-package compatibility, so the lease casts to this before reading
 * `meta.changes`, which is the whole acquire signal.
 */
export interface D1RunResult {
  meta?: { changes?: number };
}

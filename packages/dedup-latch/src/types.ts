/**
 * D1 binding shape this package needs. Declared structurally so the
 * package stays self-contained when vendored. Matches the lowest
 * common denominator used by app-sdk and the rest of the @sprigr/apps
 * packages so callers can pass the same `env.DB` binding into all of
 * them without TypeScript fighting them on `run()` return types.
 *
 * Internally we read `meta.changes` off the `run()` result. The
 * real D1Database always returns that shape; we cast at the call site.
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
 * The subset of D1Result<T> we actually look at. `run()` is declared
 * as `Promise<unknown>` for cross-package compatibility; the package
 * casts to this shape before reading `meta.changes`.
 */
export interface D1RunResult {
  meta?: { changes?: number };
}

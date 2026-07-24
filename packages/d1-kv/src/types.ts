/**
 * Minimal structural type for the per-install D1 binding.
 *
 * Inlined here so the package is self-contained when vendored.
 * Mirrors the D1Like / D1PreparedStatementLike pair in app-sdk; if
 * either drifts, prefer keeping THIS one minimal and treat app-sdk's
 * as the authoritative copy for apps to use elsewhere.
 */
export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...args: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

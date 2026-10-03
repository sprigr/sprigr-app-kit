/**
 * Minimal structural type for the per-install D1 binding.
 *
 * Inlined here so the package is self-contained when vendored (same
 * reasoning as packages/d1-kv/src/types.ts). It is byte-compatible with
 * the D1Like / D1PreparedStatementLike pair exported by app-sdk, so an
 * app can keep importing `D1Like` from '@sprigr/apps-app-sdk' and hand
 * that binding straight to `makePendingOAuthStore`.
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

/**
 * Structural minimum every pending payload must carry.
 *
 * `csrf` is the row's PRIMARY KEY (a 128-bit random minted by the app's
 * start route / connect tool). `iat` is the mint time the app stamps into
 * its own payload; the TTL is enforced against the `created_at` column,
 * not against `iat`. Apps extend this with whatever else their callback
 * needs to recover (actor identity, mode, build URL, ...).
 */
export interface PendingStateBase {
  csrf: string;
  iat: number;
}

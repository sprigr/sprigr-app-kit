/**
 * @sprigr/apps-oauth-utils — shared types.
 */

/**
 * Persistence backend for OAuth tokens. Mirrors the Sprigr platform's `KVStore` shape but stays binding-agnostic so the marketplace app can
 * back it with whatever the runtime exposes (today: per-install D1;
 * future: env.SECRETS when the runtime ships handler-side secret
 * rotation).
 */
export interface TokenStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** Result returned by every token endpoint exchange / refresh. */
export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  newRefreshToken: string | null;
}

/** Result of an authorization-code → tokens exchange. */
export interface AuthCodeResponse {
  accessToken: string;
  /**
   * Null only when the provider issues no refresh token AND the caller
   * passed `allowNoRefreshToken` (non-expiring-token providers like
   * Todoist or GitHub OAuth apps). Otherwise always present.
   */
  refreshToken: string | null;
  /**
   * Null when the provider omits `expires_in` (non-expiring access
   * tokens). The persistence helpers store `expires_at = 'never'` in
   * that case and `getValidAccessToken` serves the cached token forever.
   */
  expiresIn: number | null;
  /**
   * Space-separated scopes the provider actually granted, when the token
   * response includes a `scope` field (Google always does). Callers that
   * persist granted scopes should prefer this over the scopes they
   * requested: the user may have granted a narrower set.
   */
  scope?: string;
}

/** Provider configuration the refresh helpers need. */
export interface ProviderConfig {
  /** Short id used in errors / logs (e.g. "procore"). */
  provider: string;
  /** Token endpoint URL — fully qualified. */
  tokenUrl: string;
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /**
   * Optional bound on the token-endpoint refresh fetch, via
   * `AbortSignal.timeout`. Unset by default: the refresh fetch is unbounded
   * unless a caller opts in, and a timed-out fetch rejects with the
   * `AbortError` the runtime raises. Interactive and agent OAuth paths
   * should leave this unset, because a live user action that is merely slow
   * would otherwise hard-fail. Set it on a scheduled path, where an
   * unbounded refresh can spend the whole invocation budget
   * (sprigr/sprigr-apps#1376).
   *
   * Do NOT set it for a provider that rotates the refresh token on every
   * refresh (single-use refresh tokens). The abort can land after the
   * provider has already rotated: the old token is then invalid and the
   * new one is in a response nobody reads, so the install needs a
   * reconnect. For those providers bound only the caller's wait (race the
   * promise against a timer) and keep the refresh itself alive with
   * `ctx.waitUntil` until it has persisted.
   */
  timeoutMs?: number;
}

/** Extra body params some providers require beyond the spec. */
export interface ExchangeOptions {
  redirectUri: string;
  /** Additional form-encoded body params (e.g. scope=...). */
  extra?: Record<string, string>;
  /**
   * Accept a token response with no `refresh_token`. Set this for
   * providers whose access tokens never expire and that issue no
   * refresh token (Todoist, GitHub OAuth apps). Without it, a missing
   * refresh token is treated as a misconfigured OAuth app and throws.
   */
  allowNoRefreshToken?: boolean;
}

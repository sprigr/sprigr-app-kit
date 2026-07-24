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
  refreshToken: string;
  expiresIn: number;
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
}

/** Extra body params some providers require beyond the spec. */
export interface ExchangeOptions {
  redirectUri: string;
  /** Additional form-encoded body params (e.g. scope=...). */
  extra?: Record<string, string>;
}

/**
 * @sprigr/apps-oauth-utils — race-safe OAuth refresh.
 *
 * Seeded from the Sprigr platform's battle-tested simPRO auth
 * implementation. The race-safety pattern there is hard-won; we preserve it intact and just generalise
 * over the provider config.
 *
 * Concurrency model:
 *   - Cache-hit fast path reads from TokenStore; never touches the wire.
 *   - Cache-miss / expired calls `refreshAndPersist`, which reads the
 *     current refresh_token, posts to the provider's token endpoint,
 *     persists the new refresh_token FIRST (write-order matters — KV is
 *     not transactional; losing access_token recovers, losing
 *     refresh_token bricks), then access_token + expires_at.
 *   - On a bare `invalid_grant` (transient rotation race signature):
 *     jitter-sleep, re-read refresh_token (a sibling may have just
 *     rotated), retry once. On second failure: bubble.
 *
 * NOTE: this module deliberately does NOT depend on a Durable-Object
 * single-flight coordinator. The platform-internal simPRO impl uses one
 * for cross-isolate coalescing; a marketplace app's per-install WFP
 * script runs as a small number of isolates and the inline retry
 * recovers from the rare race. If we hit production races, add a
 * coordinator at that point.
 */

import { OAuthError, classifyOAuthError, describeOAuthFailure } from './errors';
import type { ProviderConfig, TokenStore, TokenResponse } from './types';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const RETRY_JITTER_MIN_MS = 200;
const RETRY_JITTER_MAX_MS = 600;

// Issue sprigr/sprigr-team#8134: `classifyOAuthError` classifies a
// bare/unmatched-description invalid_grant as transient on purpose — it's
// the only signature a genuine concurrent-rotation race has, and that
// self-heal is pinned by tests/errors.test.ts:20-22. But some providers
// (Google's "Bad Request") use that exact shape for a real revoked/terminal
// grant too, and the description text can't tell the two apart. Repetition
// can: a rotation race resolves on the very next refresh (this store's
// `refresh_token` was just rotated by a sibling), while a truly revoked
// grant fails the same way every time. So we let the description-based
// verdict stand on each individual failure, and only escalate to terminal
// once the same install has failed on invalid_grant this many refresh
// cycles IN A ROW with no intervening success.
const INVALID_GRANT_STREAK_ESCALATE_AFTER = 3;

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const EXPIRES_AT_KEY = 'expires_at';
const INVALID_GRANT_STREAK_KEY = 'invalid_grant_streak';

function key(prefix: string, suffix: string): string {
  return prefix ? `${prefix}${suffix}` : suffix;
}

/**
 * Called once per external `refreshAndPersist` call, only when that call is
 * about to finally give up on a transient `invalid_grant` (i.e. after the
 * in-function rotation-race retry has already been tried and failed too, or
 * wasn't eligible). Reads/bumps the per-install consecutive-failure counter
 * and, once it crosses the threshold, returns a new `OAuthError` with
 * `terminal: true` so the caller is finally told to prompt for
 * reconnection instead of hearing "transient" forever.
 *
 * Below the threshold, returns `err` unchanged — the description-based
 * verdict from `classifyOAuthError` still governs a first/second occurrence,
 * so a real rotation race (which resolves on the next refresh cycle, at the
 * latest) never gets flagged.
 */
async function escalateInvalidGrantStreak(
  store: TokenStore,
  prefix: string,
  err: OAuthError,
): Promise<OAuthError> {
  const streakKey = key(prefix, INVALID_GRANT_STREAK_KEY);
  const prevRaw = await store.get(streakKey);
  const prev = prevRaw ? parseInt(prevRaw, 10) || 0 : 0;
  const streak = prev + 1;

  if (streak >= INVALID_GRANT_STREAK_ESCALATE_AFTER) {
    await store.put(streakKey, '0');
    return new OAuthError(
      err.provider,
      /* terminal */ true,
      'revoked',
      err.status,
      `${err.message} (escalated: invalid_grant failed on ${streak} consecutive refresh cycles for this ` +
        `install with no intervening success — no longer treating as a rotation race, needs reconnection)`,
      err.errorCode,
    );
  }

  await store.put(streakKey, String(streak));
  return err;
}

/**
 * POST to the provider's token endpoint with grant_type=refresh_token.
 *
 * Throws OAuthError with `terminal: boolean` so callers can tell
 * needs-reconnect from will-self-heal.
 */
export async function refreshOAuthToken(
  config: ProviderConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const info = classifyOAuthError(config.provider, response.status, errorBody);
    console.error(
      `[${config.provider}-auth] refresh failed: status=${response.status} terminal=${info.terminal} reason=${info.reason}`,
    );
    // As in exchange.ts: the raw body is NOT interpolated. On a refresh it
    // can echo the refresh_token itself, and this message is what apps
    // write to their audit tables (sprigr/sprigr-apps#560).
    throw new OAuthError(
      config.provider,
      info.terminal,
      info.reason,
      response.status,
      describeOAuthFailure(config.provider, 'token refresh', response.status, info),
      info.errorCode,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type?: string;
    refresh_token?: string;
  };

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    newRefreshToken: data.refresh_token ?? null,
  };
}

/**
 * Get a valid access token from the store. Cache-hits are O(1) reads.
 * On miss / near-expiry, refreshes and persists.
 */
export async function getValidAccessToken(
  config: ProviderConfig,
  store: TokenStore,
  prefix = '',
): Promise<string> {
  const cached = await store.get(key(prefix, ACCESS_TOKEN_KEY));
  const expiresAtStr = await store.get(key(prefix, EXPIRES_AT_KEY));
  if (cached && expiresAtStr) {
    // 'never' = non-expiring provider token (persisted by exchangeAndPersist
    // with allowNoRefreshToken). There is no refresh cycle; serve the cached
    // token. If the provider revokes it, API calls 401 and the app should
    // surface a reconnect.
    if (expiresAtStr === 'never') {
      return cached;
    }
    const expiresAt = parseInt(expiresAtStr, 10);
    if (Date.now() < expiresAt - REFRESH_BUFFER_MS) {
      return cached;
    }
  }
  return refreshAndPersist(config, store, prefix, /* isRetry */ false);
}

/**
 * Read the stored refresh_token, exchange it, persist the new tokens.
 * Exported so test code and explicit "refresh now" handlers can drive it.
 */
export async function refreshAndPersist(
  config: ProviderConfig,
  store: TokenStore,
  prefix: string,
  isRetry: boolean,
): Promise<string> {
  const refreshToken = await store.get(key(prefix, REFRESH_TOKEN_KEY));
  if (!refreshToken) {
    throw new OAuthError(
      config.provider,
      true,
      'revoked',
      0,
      `No ${config.provider} refresh token found. Please reconnect your ${config.provider} account.`,
    );
  }

  let result: TokenResponse;
  try {
    result = await refreshOAuthToken(config, refreshToken);
  } catch (err) {
    if (!isRetry && err instanceof OAuthError && !err.terminal) {
      // Rotation-race signature — a sibling may have already rotated.
      const jitter =
        RETRY_JITTER_MIN_MS + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS));
      await new Promise((resolve) => setTimeout(resolve, jitter));
      return refreshAndPersist(config, store, prefix, /* isRetry */ true);
    }
    if (err instanceof OAuthError && !err.terminal && err.errorCode === 'invalid_grant') {
      throw await escalateInvalidGrantStreak(store, prefix, err);
    }
    throw err;
  }

  const expiresAt = Date.now() + result.expiresIn * 1000;

  // CRITICAL: persist rotated refresh_token FIRST. Writes aren't
  // transactional — if the worker dies after the access_token write but
  // before the refresh_token write, we'd have a fresh AT and a stale RT
  // the provider has already invalidated.
  if (result.newRefreshToken) {
    await store.put(key(prefix, REFRESH_TOKEN_KEY), result.newRefreshToken);
  }
  await store.put(key(prefix, ACCESS_TOKEN_KEY), result.accessToken);
  await store.put(key(prefix, EXPIRES_AT_KEY), String(expiresAt));

  // A successful refresh proves this install's grant is good again — clear
  // any invalid_grant streak so a later, unrelated failure starts counting
  // from zero rather than inheriting an old run (sprigr/sprigr-team#8134).
  // Ordered after the token writes above: those three are the write-order-
  // sensitive ones (KV isn't transactional; losing the streak counter to a
  // mid-write crash just costs one extra transient-classified cycle, not a
  // bricked install), so this stays last.
  await store.put(key(prefix, INVALID_GRANT_STREAK_KEY), '0');

  return result.accessToken;
}

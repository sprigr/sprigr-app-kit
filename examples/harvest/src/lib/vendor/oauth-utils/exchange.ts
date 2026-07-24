/**
 * @sprigr/apps-oauth-utils — authorization code → tokens exchange.
 *
 * Called from the OAuth callback route after the user consents at the
 * provider's authorize endpoint and is redirected back with a code.
 */

import { OAuthError, classifyOAuthError } from './errors';
import type { AuthCodeResponse, ExchangeOptions, ProviderConfig, TokenStore } from './types';

const REFRESH_TOKEN_KEY = 'refresh_token';
const ACCESS_TOKEN_KEY = 'access_token';
const EXPIRES_AT_KEY = 'expires_at';

function key(prefix: string, suffix: string): string {
  return prefix ? `${prefix}${suffix}` : suffix;
}

/**
 * Exchange an OAuth authorization code for tokens.
 * Most providers return both access and refresh tokens here; Procore does.
 */
export async function exchangeAuthCode(
  config: ProviderConfig,
  code: string,
  opts: ExchangeOptions,
): Promise<AuthCodeResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...(opts.extra ?? {}),
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const { terminal, reason } = classifyOAuthError(config.provider, response.status, errorBody);
    throw new OAuthError(
      config.provider,
      terminal,
      reason,
      response.status,
      `${config.provider} code exchange failed (${response.status}): ${errorBody}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  };

  if (!data.refresh_token) {
    throw new Error(
      `No refresh token returned from ${config.provider}. Ensure the OAuth app is configured for offline access (use 'offline_access' scope or check the provider's docs).`,
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    // Granted-scope echo (space-separated). Present on Google and most
    // spec-compliant providers; absent elsewhere, so it stays optional.
    ...(typeof data.scope === 'string' && data.scope.length > 0 ? { scope: data.scope } : {}),
  };
}

/**
 * Convenience: exchange + persist in one call. Most callbacks want this.
 */
export async function exchangeAndPersist(
  config: ProviderConfig,
  store: TokenStore,
  code: string,
  opts: ExchangeOptions,
  prefix = '',
): Promise<AuthCodeResponse> {
  const result = await exchangeAuthCode(config, code, opts);
  const expiresAt = Date.now() + result.expiresIn * 1000;
  // Same write-order as refreshAndPersist — refresh_token first.
  await store.put(key(prefix, REFRESH_TOKEN_KEY), result.refreshToken);
  await store.put(key(prefix, ACCESS_TOKEN_KEY), result.accessToken);
  await store.put(key(prefix, EXPIRES_AT_KEY), String(expiresAt));
  return result;
}

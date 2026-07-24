/**
 * @sprigr/apps-oauth-utils — OAuth error classification.
 *
 * Distinguishes terminal (revoked / consent_required / expired) failures
 * that genuinely need operator re-auth from transient blips (rotation
 * race, 5xx, network) that should be retried without nagging the user.
 *
 * Modeled on the simPRO classifier in sprigr-team
 * (packages/auth/src/errors.ts), kept generic so the same shape covers
 * Procore and any future OAuth provider an app in this repo wraps.
 */

export type OAuthErrorReason =
  | 'revoked'
  | 'expired'
  | 'consent_required'
  | 'transient'
  | 'unknown';

export class OAuthError extends Error {
  readonly name = 'OAuthError';
  constructor(
    public readonly provider: string,
    public readonly terminal: boolean,
    public readonly reason: OAuthErrorReason,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * Classify an OAuth token-endpoint non-OK response.
 *
 * Strategy mirrors simPRO's classifier:
 *   - 5xx / network → transient.
 *   - 4xx invalid_grant with terminal description → terminal.
 *   - Bare 4xx invalid_grant (no description) → transient (rotation race).
 *   - Other 4xx → unknown (callers treat as transient + log).
 *
 * Procore returns standard OAuth2 error bodies — invalid_grant /
 * invalid_client / invalid_scope. The terminal/transient split above
 * works against Procore's shapes; if we see surprising returns in
 * staging, fold them into the description regex below.
 */
export function classifyOAuthError(
  provider: string,
  status: number,
  rawBody: string,
): { terminal: boolean; reason: OAuthErrorReason } {
  if (status >= 500) return { terminal: false, reason: 'transient' };

  let parsed: OAuthErrorBody | null = null;
  try {
    parsed = JSON.parse(rawBody) as OAuthErrorBody;
  } catch {
    parsed = null;
  }
  const errCode = parsed?.error ?? '';
  const desc = parsed?.error_description ?? '';

  if (errCode === 'invalid_grant') {
    if (/revoked|consent_required|access_denied/i.test(desc)) {
      return { terminal: true, reason: 'revoked' };
    }
    if (/expired/i.test(desc)) {
      return { terminal: true, reason: 'expired' };
    }
    return { terminal: false, reason: 'transient' };
  }

  if (errCode === 'invalid_client' || errCode === 'unauthorized_client') {
    return { terminal: true, reason: 'revoked' };
  }

  if (status >= 400 && status < 500) {
    return { terminal: false, reason: 'unknown' };
  }
  return { terminal: false, reason: 'transient' };
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export function _ensureProviderUnused(_provider: string): void {
  /* placeholder so `provider` is part of the public surface */
}

/**
 * @sprigr/apps-oauth-utils — OAuth error classification.
 *
 * Distinguishes terminal (revoked / consent_required / expired) failures
 * that genuinely need operator re-auth from transient blips (rotation
 * race, 5xx, network) that should be retried without nagging the user.
 *
 * Modeled on the Sprigr platform's simPRO error classifier, kept generic so the same shape covers
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
 * What `classifyOAuthError` learned from the provider's response body.
 *
 * `terminal` + `reason` are the original contract and are unchanged.
 * The rest exists so a caller can build a failure message out of the
 * SPEC-DEFINED fields instead of interpolating the raw body. See
 * `describeOAuthFailure` and issue sprigr/sprigr-apps#560.
 */
export interface OAuthErrorClassification {
  terminal: boolean;
  reason: OAuthErrorReason;
  /** The body's `error` code, e.g. `invalid_grant`. '' when absent. */
  errorCode: string;
  /** The body's `error_description`. '' when absent. */
  errorDescription: string;
  /** The body did not parse as JSON (HTML error page, plain text, empty). */
  unparsed: boolean;
  /** Byte length of the body we were given, so an omission is quantified. */
  bodyLength: number;
}

/**
 * Build the message for an `OAuthError` WITHOUT interpolating the raw
 * provider body.
 *
 * Why (issue sprigr/sprigr-apps#560): the token endpoint's response body
 * is provider-controlled and routinely echoes back the request parameters that
 * produced the failure, which include the authorization `code`, the
 * `client_secret`, and on a refresh the `refresh_token`. Every consuming
 * app writes `err.message` into a durable per-install audit column, and
 * several of those columns are read back to an agent tool caller or
 * rendered on the app's settings page. Interpolating the body put a
 * provider-controlled, credential-bearing string one hop from a durable
 * store with no transform but a length cap.
 *
 * What survives, because the audit row exists to be debugged from: the
 * provider, the operation, the HTTP status, our terminal/transient
 * classification, and the two spec-defined fields (`error`,
 * `error_description`) that actually distinguish `invalid_grant` from
 * `invalid_client`.
 *
 * What is dropped: a body that did not parse as OAuth-shaped JSON. That
 * drop is NOT silent: the message says a body was withheld and how many
 * bytes it was, so a reader can tell the difference between "the provider
 * said nothing" and "the provider said something we refused to persist".
 */
export function describeOAuthFailure(
  provider: string,
  operation: string,
  status: number,
  info: OAuthErrorClassification,
): string {
  const parts = [`${provider} ${operation} failed (${status})`, `reason=${info.reason}`];
  if (info.errorCode) parts.push(`error=${info.errorCode}`);
  if (info.errorDescription) parts.push(`error_description=${info.errorDescription}`);
  if (info.unparsed && info.bodyLength > 0) {
    parts.push(
      `provider body withheld (${info.bodyLength} bytes, not OAuth JSON; ` +
        `raw bodies can carry credentials and this string is persisted)`,
    );
  }
  return parts.join('; ');
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
): OAuthErrorClassification {
  let parsed: OAuthErrorBody | null = null;
  try {
    const candidate: unknown = JSON.parse(rawBody);
    parsed =
      candidate && typeof candidate === 'object' ? (candidate as OAuthErrorBody) : null;
  } catch {
    parsed = null;
  }
  const errCode = typeof parsed?.error === 'string' ? parsed.error : '';
  const desc = typeof parsed?.error_description === 'string' ? parsed.error_description : '';

  const body = {
    errorCode: errCode,
    errorDescription: desc,
    unparsed: parsed === null,
    bodyLength: rawBody ? rawBody.length : 0,
  };

  if (status >= 500) return { terminal: false, reason: 'transient', ...body };

  if (errCode === 'invalid_grant') {
    if (/revoked|consent_required|access_denied/i.test(desc)) {
      return { terminal: true, reason: 'revoked', ...body };
    }
    if (/expired/i.test(desc)) {
      return { terminal: true, reason: 'expired', ...body };
    }
    return { terminal: false, reason: 'transient', ...body };
  }

  if (errCode === 'invalid_client' || errCode === 'unauthorized_client') {
    return { terminal: true, reason: 'revoked', ...body };
  }

  if (status >= 400 && status < 500) {
    return { terminal: false, reason: 'unknown', ...body };
  }
  return { terminal: false, reason: 'transient', ...body };
}

/* eslint-disable @typescript-eslint/no-unused-vars */
export function _ensureProviderUnused(_provider: string): void {
  /* placeholder so `provider` is part of the public surface */
}

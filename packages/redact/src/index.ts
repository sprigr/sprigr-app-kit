/**
 * @sprigr/apps-redact: strip credential-shaped values out of strings that
 * are about to be written somewhere durable.
 *
 * WHY THIS EXISTS (issue sprigr/sprigr-apps#560)
 * ---------------------------
 * Marketplace apps persist failure detail into per-install audit tables
 * (`*_audit.detail` / `.error`, `*.last_error`) and several of them read
 * those rows back out to an agent tool caller or render them on the app's
 * settings page. The strings that land there are frequently built by
 * interpolating a provider's raw HTTP response body into an Error message.
 * A token endpoint's error body is provider-controlled and can echo back
 * request parameters, so an authorization `code`, a `client_secret`, or a
 * `refresh_token` can reach a durable column with no transform other than a
 * length cap. Nothing in the repo redacted any of it before this package.
 *
 * WHAT THIS DOES AND DOES NOT DO
 * ------------------------------
 * `redactSecrets` removes VALUES, never structure and never diagnostics.
 * Status codes, provider error codes (`invalid_grant`), human-readable
 * `error_description` text, request ids, URLs and identifiers all survive
 * verbatim. That is deliberate: an operator debugging a failed connection
 * needs exactly those, and a blanket detail-stripper would trade one bug
 * for a worse one.
 *
 * It does NOT truncate. Callers that already cap a field keep their own
 * cap; this function never shortens its input beyond replacing a matched
 * secret with the placeholder.
 *
 * It is a best-effort textual filter, not a proof of absence. It works on
 * raw text rather than parsed JSON on purpose, because the bodies it sees
 * are often malformed, HTML, or form-encoded. A novel credential format
 * with no recognisable key name and no recognisable prefix will pass
 * through. Treat it as defence in depth over "do not put secrets in
 * messages in the first place", not as a licence to.
 */

/** What a redacted value is replaced with. Visible on purpose: a reader can
 * tell the difference between "no value" and "a value was removed here". */
export const SECRET_PLACEHOLDER = '[redacted]';

/**
 * Key-name fragments that mark the associated value as a credential.
 * Matched case-insensitively as a SUBSTRING of the key, so `client_secret`,
 * `clientSecret`, `X-Api-Key` and `refresh_token` all hit.
 */
const SECRET_KEY_FRAGMENTS = [
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'api_key',
  'apikey',
  'api-key',
  'authorization',
  'private_key',
  'privatekey',
  'signature',
  'hmac',
  'session_id',
  'sessionid',
  'cookie',
];

/** Whole key names that are credentials but carry no fragment above. */
const SECRET_KEY_EXACT = ['code_verifier', 'pwd', 'assertion', 'client_assertion'];

/**
 * Keys whose value is a credential SOMETIMES. `code` is the worst of them:
 * in a token-endpoint error body it is the OAuth authorization code (a
 * bearer credential until it is spent, and providers do echo it back), but
 * in a Google/Klaviyo/Meta API error body it is the machine-readable error
 * code (`PERMISSION_DENIED`, `invalid`) that an operator debugs from.
 *
 * For these, the VALUE decides: see `looksHighEntropy`. Redacting them
 * unconditionally would delete exactly the diagnostic the audit row exists
 * to carry.
 */
const AMBIGUOUS_SECRET_KEY_EXACT = new Set([
  'code',
  'auth',
  'state',
  'nonce',
  'signature',
  'hmac',
  'session_id',
  'sessionid',
]);

/**
 * Does this value look like a credential rather than a symbolic code?
 *
 * Symbolic error codes are short-ish words joined by `_`, `-`, `.` or a
 * space, with no digits: `PERMISSION_DENIED`, `invalid_request`,
 * `rate_limit_exceeded`. Credentials are longer and carry digits or
 * characters outside that alphabet (`4/0AVMBsJi...`, a hex HMAC, base64).
 */
function looksHighEntropy(value: string): boolean {
  if (value.length < 16) return false;
  const isSymbolicWords = /^[A-Za-z][A-Za-z0-9]*(?:[ _.-][A-Za-z0-9]+)*$/.test(value);
  if (isSymbolicWords && !/\d/.test(value)) return false;
  return true;
}

/**
 * Keys that contain a fragment above but are NOT secrets, and are useful
 * diagnostics. Without this list `"token_type":"Bearer"` and
 * `"error_description":"Token has been expired"` lose information for no
 * security gain. (The description case is already safe (the key is
 * `error_description`), but `token_type` and friends are not.)
 */
const NON_SECRET_KEY_EXACT = new Set([
  'token_type',
  'token_endpoint',
  'tokenurl',
  'token_url',
  'expires_in',
  'refresh_token_expires_in',
  'access_token_expires_in',
  'not-before-policy',
  'error',
  'error_code',
  'error_description',
  'error_uri',
  'error_subcode',
  'status_code',
]);

type KeyClass = 'secret' | 'ambiguous' | 'plain';

function classifyKey(rawKey: string, extra: string[]): KeyClass {
  const key = rawKey.trim().toLowerCase();
  if (extra.some((e) => key === e || key.includes(e))) return 'secret';
  if (NON_SECRET_KEY_EXACT.has(key)) return 'plain';
  if (AMBIGUOUS_SECRET_KEY_EXACT.has(key)) return 'ambiguous';
  if (SECRET_KEY_EXACT.includes(key)) return 'secret';
  if (SECRET_KEY_FRAGMENTS.some((f) => key.includes(f))) return 'secret';
  return 'plain';
}

/**
 * Credential shapes worth removing even when they appear with no key at
 * all: inside a free-text error message, an HTML error page, or a URL.
 * Each entry is anchored on a prefix a real credential format uses, so the
 * risk of eating a useful identifier is low.
 */
const STANDALONE_SECRET_PATTERNS: RegExp[] = [
  // `Authorization: Bearer <t>` / `Basic <b64>` however it got into the text.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // JWT / any three dot-separated base64url segments starting with a JSON header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Google OAuth: access tokens, refresh tokens, client secrets, API keys.
  /\bya29\.[A-Za-z0-9._~+/-]{10,}/g,
  /\b1\/\/[A-Za-z0-9._~+/-]{20,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  // Shopify admin / storefront / custom-app tokens.
  /\bshp(at|ca|pa|ss)_[A-Za-z0-9]{16,}/g,
  // Slack bot/user/app/refresh tokens and signing secrets.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  // Meta / Facebook long-lived user + page access tokens.
  /\bEAA[A-Za-z0-9]{30,}/g,
  // Atlassian / Anthropic / OpenAI style prefixed keys.
  /\bATATT[A-Za-z0-9._-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub personal access / app tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
];

/**
 * `"key": "value"` in JSON (or anything JSON-shaped). Captures the key so
 * the replacement can decide per key. Values may contain escaped quotes.
 */
const JSON_PAIR_RE = /("([A-Za-z0-9_.\-[\]]{1,64})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/**
 * `key=value` in a form-encoded body or a query string. Value runs to the
 * next `&`, whitespace, quote, or end. Deliberately does NOT match across
 * `&` so a single long body redacts pair by pair.
 */
const FORM_PAIR_RE = /([A-Za-z0-9_.\-[\]]{1,64})=([^&\s"'<>]{1,4096})/g;

export interface RedactOptions {
  /**
   * Extra key names/fragments to treat as secret, for a provider with an
   * unusual parameter name. Matched the same way as the built-in list.
   */
  extraSecretKeys?: string[];
}

/**
 * Remove credential-shaped values from an arbitrary string.
 *
 * Safe to call on app-authored strings: a summary like
 * `{"customers":3,"defaultCustomerId":"123"}` comes back unchanged, because
 * nothing in it is keyed or shaped like a credential.
 *
 * Never truncates, never reorders, never drops non-secret content.
 */
export function redactSecrets(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;

  const extra = (opts.extraSecretKeys ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const shouldRedact = (key: string, value: string): boolean => {
    const cls = classifyKey(key, extra);
    if (cls === 'secret') return true;
    if (cls === 'ambiguous') return looksHighEntropy(value);
    return false;
  };

  let out = input;

  // 1. Keyed values, JSON shape.
  out = out.replace(JSON_PAIR_RE, (whole, prefix: string, key: string, value: string) =>
    shouldRedact(key, value) ? `${prefix}"${SECRET_PLACEHOLDER}"` : whole,
  );

  // 2. Keyed values, form-encoded / query-string shape.
  out = out.replace(FORM_PAIR_RE, (whole, key: string, value: string) =>
    shouldRedact(key, value) ? `${key}=${SECRET_PLACEHOLDER}` : whole,
  );

  // 3. Unkeyed values whose own shape gives them away.
  for (const re of STANDALONE_SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      // Keep the scheme word on an Authorization header so the reader can
      // still see WHICH scheme was rejected.
      const scheme = /^(Bearer|Basic)\s/i.exec(match);
      return scheme ? `${scheme[1]} ${SECRET_PLACEHOLDER}` : SECRET_PLACEHOLDER;
    });
  }

  return out;
}

/**
 * Convenience for the commonest call shape: turn an unknown thrown value
 * into a redacted string for a durable audit column.
 *
 * Does not truncate; a caller that needs a cap applies its own, visibly.
 */
export function redactErrorMessage(err: unknown, opts: RedactOptions = {}): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, opts);
}

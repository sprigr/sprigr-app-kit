/**
 * OAuth `state` parameter encode / decode.
 *
 * Carries a small bag of context (install_id, csrf, target environment,
 * return URL) through the provider's authorize → callback round trip.
 * Base64url-encoded JSON so it survives URL encoding without escaping.
 *
 * IMPORTANT: state is observable by the user — never include secrets,
 * tokens, or PII. The CSRF token is the only "secret" and is checked
 * against the install's pending-flow store, not used to authorize
 * anything directly.
 */

export interface OAuthState {
  /** Sprigr install ID this OAuth flow belongs to. */
  installId: string;
  /** Random CSRF token; the callback compares it against the install's stored pending value. */
  csrf: string;
  /** Procore environment to use ('prod' | 'sandbox' | 'monthly'). */
  environment?: string;
  /** Optional return URL after the flow completes. */
  returnTo?: string;
  /** Issued-at — useful for expiring stale state. */
  iat: number;
  /**
   * Sprigr actor initiating the flow — the OIDC sub of the user clicking
   * "Connect". Used by apps with per-actor OAuth (simPRO) so the callback
   * knows which actor's token row to write. Absent for apps with one
   * connection per install (procore, shopify).
   */
  actorPlatformUserId?: string;
  /**
   * Agent id when the flow was initiated by an unbound agent (no platform
   * user). Apps that key per-actor state fall back to this when
   * actorPlatformUserId is absent.
   */
  actorAgentId?: string;
  /**
   * Per-tenant provider host (e.g. simPRO's `https://acme.simprosuite.com`).
   * Carried in state so the callback can re-use the same host the start
   * route validated, without re-querying the user.
   */
  buildUrl?: string;
  /**
   * Auth method discriminator for providers that support multiple flows
   * (simPRO: oauth / client_credentials / api_key). Absent for single-
   * method providers.
   */
  authMethod?: string;
}

function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeState(state: OAuthState): string {
  const json = JSON.stringify(state);
  return base64urlEncode(new TextEncoder().encode(json));
}

export function decodeState(encoded: string): OAuthState {
  const bytes = base64urlDecode(encoded);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as OAuthState;
}

/**
 * Longest platform-signed state the platform sends to a provider. Dropbox
 * documents 500 bytes, the tightest cap among the marketplace's providers.
 * Mirrors OAUTH_STATE_ENVELOPE_MAX_CHARS in sprigr-team
 * packages/shared/src/utils/oauth-state-envelope.ts (decision 0190): a state
 * whose envelope would pass it is sent UNSIGNED, and a slug on the bouncer's
 * enforce list then refuses the connect.
 */
export const OAUTH_STATE_ENVELOPE_MAX_CHARS = 500;

/**
 * Characters the platform's signed envelope adds around an app's state.
 * The wire shape is `sps1.<inner>.<payload>.<sig>`: payload is base64url JSON
 * `{ i: installId, a: appSlug, t: <ms> }` and sig is 16 HMAC bytes, 22
 * base64url characters (mintOAuthStateEnvelope in sprigr-team). `t` is the
 * platform's signing time; any 13-digit ms timestamp gives the same length.
 */
export function oauthStateEnvelopeOverhead(installId: string, appSlug: string, t: number = Date.now()): number {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ i: installId, a: appSlug, t })).length;
  const payloadChars = Math.ceil((payloadBytes * 4) / 3); // unpadded base64url
  return 'sps1.'.length + 1 + payloadChars + 1 + 22;
}

export interface EncodeStateWithinEnvelopeOptions {
  /** The install the platform signs into the envelope (env.INSTALL_ID). */
  installId: string;
  /** This app's marketplace slug, also signed into the envelope. */
  appSlug: string;
  /**
   * Fields that may be left out, WHOLE, when the state would not fit, tried
   * in this order. Default `['returnTo']`. List only fields the callback can
   * do without: without returnTo the bouncer lands the user on the install's
   * dashboard instead of the requested page.
   */
  optional?: ReadonlyArray<keyof OAuthState>;
}

export interface EncodedStateWithinEnvelope {
  /** The encoded state to put on the authorize URL. */
  state: string;
  /** Optional fields left out to make it fit, in the order they were dropped. */
  omitted: string[];
  /** False when even the state without its optional fields is too long; it is then returned in full and the platform will send it unsigned. */
  fits: boolean;
}

/**
 * encodeState, but leaving room for the platform's signed envelope
 * (sprigr-apps#3190). An optional field that does not fit is left out whole,
 * never shortened: a cut returnTo is a broken landing page, and an absent one
 * falls back to the install's dashboard. Each omission is logged with the
 * field's length and the state's length before and after, so the cause of a
 * dashboard landing is findable.
 */
export function encodeStateWithinEnvelope(
  state: OAuthState,
  opts: EncodeStateWithinEnvelopeOptions,
): EncodedStateWithinEnvelope {
  const budget = OAUTH_STATE_ENVELOPE_MAX_CHARS - oauthStateEnvelopeOverhead(opts.installId, opts.appSlug);
  const full = encodeState(state);
  if (full.length <= budget) return { state: full, omitted: [], fits: true };

  const trimmed: Record<string, unknown> = { ...state };
  const omitted: string[] = [];
  for (const key of opts.optional ?? ['returnTo']) {
    if (!(key in trimmed) || trimmed[key] === undefined) continue;
    const value = trimmed[key];
    delete trimmed[key];
    omitted.push(key);
    const candidate = encodeState(trimmed as unknown as OAuthState);
    if (candidate.length <= budget) {
      console.warn(
        `[oauth-state] ${opts.appSlug}: left ${omitted.join(', ')} out of the OAuth state so it can be signed ` +
          `(${String(key)} was ${typeof value === 'string' ? value.length : JSON.stringify(value).length} chars; ` +
          `state ${full.length} -> ${candidate.length} chars, room ${budget}). The connect lands on the install's dashboard.`,
      );
      return { state: candidate, omitted, fits: true };
    }
  }
  console.warn(
    `[oauth-state] ${opts.appSlug}: the OAuth state is ${full.length} chars and only ${budget} fit inside the signed envelope ` +
      `even without its optional fields, so the platform will send it unsigned.`,
  );
  return { state: full, omitted: [], fits: false };
}

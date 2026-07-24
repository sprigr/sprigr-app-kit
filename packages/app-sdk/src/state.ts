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

/**
 * Who is looking at this app's UI right now.
 *
 * A marketplace app UI is embedded in the portal iframe with only
 * `#install_id=...` in its src, so nothing about the human viewer arrives in
 * the URL. It arrives in HTTP headers the platform's `website-serve` worker
 * stamps on every dispatch, and this module is the ONE place that reads them.
 *
 * ## Use this, do not hand-roll `src/lib/viewer.ts`
 *
 * Twelve apps in `sprigr-apps` each carried their own copy of this logic as
 * of 2026-09-03, all textually different. Five apps had a query-param
 * fallback that outranked the header, which is a connection-hijack bug (any
 * tenant member could bind their own provider account to a colleague's actor
 * row): `sprigr-apps` #1487-#1491, and `sprigr-apps#474` before them. That is
 * why this lives in the SDK.
 *
 * **Never take a viewer identity from a query param, a form field, a cookie
 * your app set, or a `postMessage` payload — not even as a fallback for when
 * the header is missing.** A missing header means "no viewer"; it does not
 * mean "believe the client".
 *
 * ## Two channels, one preferred
 *
 * - **`X-Sprigr-Viewer`** (preferred, platform issue #3210): a signed token
 *   naming the viewer, bound to YOUR install and expiring in ~2 minutes.
 *   Everything in it is inside an HMAC your install alone can check, using
 *   the `SPRIGR_VIEWER_SECRET` binding the platform derives per install. It
 *   is the only channel that carries a display name.
 * - **`x-sprigr-platform-user-id`** (legacy): the viewer's OIDC sub as a
 *   plain header. Not signed. It rests on transport integrity: your Worker
 *   is reachable only through the platform's WFP dispatch, and the platform
 *   overwrites the header unconditionally on every forward, so a browser
 *   cannot smuggle its own value through. That is a real guarantee, but you
 *   cannot verify it yourself.
 *
 * `resolveViewerContext` prefers the signed channel and returns
 * `trust: 'verified'`. The legacy channel is used ONLY when you pass
 * `allowTransportFallback: true`, and then reports `trust: 'transport'`. The
 * fallback is opt-in per call site on purpose: it is needed while an install
 * predates its `SPRIGR_VIEWER_SECRET` binding (the platform binds it on the
 * install's next build or rebind), and it should be dropped once every
 * install has been rebound.
 */

/** Header carrying the signed viewer context. */
export const VIEWER_CONTEXT_HEADER = 'x-sprigr-viewer';

/** Legacy transport-attested header carrying the viewer's OIDC sub. */
export const VIEWER_PLATFORM_USER_ID_HEADER = 'x-sprigr-platform-user-id';

/** Legacy transport-attested header carrying the sprigr-team `users.id`. */
export const VIEWER_USER_ID_HEADER = 'x-sprigr-user-id';

/** Legacy transport-attested header carrying the viewer's company role. */
export const VIEWER_ROLE_HEADER = 'x-sprigr-role';

/** Sentinel both id headers carry when nobody is signed in. */
export const VIEWER_ANONYMOUS = 'anonymous';

const TOKEN_VERSION = 'svc1';
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

/** Raw wire claims. snake_case because they are the signed payload. */
interface WireClaims {
  install_id: string;
  company_id: string;
  user_id: string;
  platform_user_id: string;
  role: string;
  display_name?: string;
  email?: string;
  issued_at: number;
  expires_at: number;
}

/** The resolved viewer. */
export interface ViewerContext {
  /**
   * How this was established.
   *
   *  - `'verified'` — the signed `X-Sprigr-Viewer` token checked out against
   *    your install's own key. Authorise on this.
   *  - `'transport'` — the legacy unsigned header, accepted because the call
   *    site passed `allowTransportFallback`. Same practical guarantee the
   *    platform has always given, but nothing was cryptographically checked
   *    and `displayName` / `email` are never available.
   */
  trust: 'verified' | 'transport';
  /** OIDC sub (`usr_...`) of the viewer, or null when signed out. This is
   *  what per-actor state keys on. */
  platformUserId: string | null;
  /** sprigr-team `users.id` row id, or null when signed out. */
  userId: string | null;
  /** Company that owns the install. Null on the legacy channel when the
   *  header is absent. */
  companyId: string | null;
  /** The viewer's role at the company, or null when signed out. */
  role: string | null;
  /** Display name. Only ever present on a verified context. DISPLAY ONLY —
   *  never branch authorisation on it. */
  displayName: string | null;
  /** Email. Only ever present on a verified context. DISPLAY ONLY. */
  email: string | null;
  /** The install the context was minted for. Null on the legacy channel. */
  installId: string | null;
}

export interface ViewerEnv {
  /** Per-install key the platform derives and binds. Absent on an install
   *  that has not been rebuilt since the platform started binding it. */
  SPRIGR_VIEWER_SECRET?: string;
  /** This install's id, bound by the platform. Used to refuse a context
   *  minted for a different install. */
  INSTALL_ID?: string;
}

export interface ResolveViewerOptions {
  /**
   * Accept the legacy unsigned `x-sprigr-platform-user-id` header when no
   * verified token is available. Defaults to FALSE: a call site that wants
   * the weaker guarantee has to say so, so the weaker path is visible in
   * review instead of being the silent default.
   */
  allowTransportFallback?: boolean;
  /** Override the clock, for tests. Epoch seconds. */
  nowSeconds?: number;
  /** Override the future-issued tolerance, in seconds. */
  clockSkewSeconds?: number;
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export type ViewerContextFailure =
  | 'missing'
  | 'no_secret'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'install_mismatch';

export type ViewerContextVerification =
  | { ok: true; claims: WireClaims }
  | { ok: false; reason: ViewerContextFailure };

/**
 * Verify a raw `X-Sprigr-Viewer` token.
 *
 * Most apps want `resolveViewerContext` instead; reach for this when you
 * need to log or branch on the specific failure reason. Do NOT surface the
 * reason to the browser: collapse every failure into the same "no viewer"
 * outcome so a caller learns nothing from probing.
 *
 * The signature is checked before any claim, so nothing about an unsigned
 * payload is observable through the failure reason.
 */
export async function verifyViewerToken(
  token: string | null | undefined,
  env: ViewerEnv,
  options: ResolveViewerOptions = {},
): Promise<ViewerContextVerification> {
  if (!token) return { ok: false, reason: 'missing' };
  const secret = env.SPRIGR_VIEWER_SECRET;
  if (!secret) return { ok: false, reason: 'no_secret' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  const payloadB64 = parts[1] as string;
  const macB64 = parts[2] as string;

  const provided = base64urlDecode(macB64);
  if (!provided) return { ok: false, reason: 'malformed' };
  const expected = await hmacBytes(secret, `${TOKEN_VERSION}.${payloadB64}`);
  if (!constantTimeEqualBytes(provided, expected)) return { ok: false, reason: 'bad_signature' };

  const payloadBytes = base64urlDecode(payloadB64);
  if (!payloadBytes) return { ok: false, reason: 'malformed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const p = parsed as Partial<WireClaims> | null;
  if (
    !p || typeof p !== 'object'
    || typeof p.install_id !== 'string' || !p.install_id
    || typeof p.company_id !== 'string' || !p.company_id
    || typeof p.user_id !== 'string' || !p.user_id
    || typeof p.platform_user_id !== 'string' || !p.platform_user_id
    || typeof p.role !== 'string' || !p.role
    || typeof p.issued_at !== 'number' || !Number.isFinite(p.issued_at)
    || typeof p.expires_at !== 'number' || !Number.isFinite(p.expires_at)
    || (p.display_name !== undefined && typeof p.display_name !== 'string')
    || (p.email !== undefined && typeof p.email !== 'string')
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (now >= p.expires_at) return { ok: false, reason: 'expired' };
  if (p.issued_at - now > skew) return { ok: false, reason: 'not_yet_valid' };
  // Belt and braces. The per-install key already makes a cross-install token
  // unverifiable; this turns a MISBOUND secret into a loud refusal rather
  // than a silent cross-install identity.
  if (env.INSTALL_ID && p.install_id !== env.INSTALL_ID) {
    return { ok: false, reason: 'install_mismatch' };
  }
  return { ok: true, claims: p as WireClaims };
}

function anonymousOrValue(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || v === VIEWER_ANONYMOUS) return null;
  return v;
}

/**
 * Resolve the viewer from a request's headers.
 *
 *   const viewer = await resolveViewerContext(request.headers, env);
 *   if (!viewer?.platformUserId) return jsonError(401, 'sign in to continue');
 *   // authorise on viewer.platformUserId, render viewer.displayName
 *
 * Returns null when there is no viewer at all: no token (or one that did not
 * verify) and either no legacy header or no `allowTransportFallback`. A
 * signed-out visitor on a verified context comes back non-null with every id
 * field null, so an app can tell "nobody is signed in" from "I cannot tell".
 */
export async function resolveViewerContext(
  headers: Headers,
  env: ViewerEnv,
  options: ResolveViewerOptions = {},
): Promise<ViewerContext | null> {
  const verified = await verifyViewerToken(headers.get(VIEWER_CONTEXT_HEADER), env, options);
  if (verified.ok) {
    const c = verified.claims;
    const platformUserId = anonymousOrValue(c.platform_user_id);
    return {
      trust: 'verified',
      platformUserId,
      userId: anonymousOrValue(c.user_id),
      companyId: c.company_id,
      role: anonymousOrValue(c.role),
      // Display fields are ignored for a signed-out viewer even if a future
      // platform version were to send them: a name with no identity behind
      // it has nobody to belong to.
      displayName: platformUserId ? (c.display_name ?? null) : null,
      email: platformUserId ? (c.email ?? null) : null,
      installId: c.install_id,
    };
  }

  if (!options.allowTransportFallback) return null;

  const platformUserId = anonymousOrValue(headers.get(VIEWER_PLATFORM_USER_ID_HEADER));
  const userId = anonymousOrValue(headers.get(VIEWER_USER_ID_HEADER));
  if (!platformUserId && !userId) return null;
  return {
    trust: 'transport',
    platformUserId,
    userId,
    companyId: null,
    role: anonymousOrValue(headers.get(VIEWER_ROLE_HEADER)),
    // The legacy channel never carries these.
    displayName: null,
    email: null,
    installId: null,
  };
}

/**
 * The viewer's platform user id, or null.
 *
 * The narrow shape the twelve hand-rolled `viewer.ts` copies exposed, so an
 * app can migrate onto the SDK in one import change and adopt the richer
 * context later. `allowTransportFallback` defaults to TRUE here and only
 * here, because that is exactly what those copies did — an app that wants
 * the stronger guarantee should call `resolveViewerContext` directly.
 */
export async function resolveViewerUserId(
  headers: Headers,
  env: ViewerEnv,
  options: ResolveViewerOptions = {},
): Promise<string | null> {
  const viewer = await resolveViewerContext(headers, env, {
    allowTransportFallback: true,
    ...options,
  });
  return viewer?.platformUserId ?? null;
}

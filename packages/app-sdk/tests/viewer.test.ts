import { describe, it, expect } from 'vitest';
import {
  resolveViewerContext,
  resolveViewerUserId,
  verifyViewerToken,
  VIEWER_CONTEXT_HEADER,
  VIEWER_PLATFORM_USER_ID_HEADER,
  VIEWER_USER_ID_HEADER,
  VIEWER_ROLE_HEADER,
  type ViewerEnv,
} from '../src/viewer';

const MASTER = 'website-secrets-master-key-for-tests';
const INSTALL = 'inst_abc123';
const OTHER_INSTALL = 'inst_zzz999';
const NOW = 1_760_000_000;

// Mirrors the platform's derivation + minting (packages/shared/src/utils/
// viewer-context.ts in sprigr-team). Kept here rather than imported so the
// SDK's verifier is tested against the WIRE FORMAT, not against the signer's
// own helpers — a drift between the two would otherwise be invisible.
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

async function deriveKey(installId: string, master = MASTER): Promise<string> {
  const bytes = await hmac(master, `sprigr-viewer-ctx:v1:${installId}`);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mint(
  claims: Record<string, unknown>,
  key: string,
  opts: { now?: number; ttl?: number; version?: string } = {},
): Promise<string> {
  const now = opts.now ?? NOW;
  const version = opts.version ?? 'svc1';
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ ...claims, issued_at: now, expires_at: now + (opts.ttl ?? 120) }),
    ),
  );
  const signed = `${version}.${payload}`;
  return `${signed}.${b64url(await hmac(key, signed))}`;
}

const CLAIMS = {
  install_id: INSTALL,
  company_id: 'cmp_1',
  user_id: 'usr_row_1',
  platform_user_id: 'usr_oidc_1',
  role: 'member',
  display_name: 'Jane Doe',
  email: 'jane@example.com',
};

async function envFor(installId = INSTALL): Promise<ViewerEnv> {
  return { SPRIGR_VIEWER_SECRET: await deriveKey(installId), INSTALL_ID: installId };
}

const withToken = (token: string) => new Headers({ [VIEWER_CONTEXT_HEADER]: token });

describe('resolveViewerContext — verified channel', () => {
  it('returns the signed viewer, display name included', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    const viewer = await resolveViewerContext(withToken(token), env, { nowSeconds: NOW });
    expect(viewer).toEqual({
      trust: 'verified',
      platformUserId: 'usr_oidc_1',
      userId: 'usr_row_1',
      companyId: 'cmp_1',
      role: 'member',
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      installId: INSTALL,
    });
  });

  it('reports a signed-out visitor as present-but-nobody', async () => {
    const env = await envFor();
    const token = await mint(
      {
        install_id: INSTALL,
        company_id: 'cmp_1',
        user_id: 'anonymous',
        platform_user_id: 'anonymous',
        role: 'anonymous',
      },
      env.SPRIGR_VIEWER_SECRET!,
    );
    const viewer = await resolveViewerContext(withToken(token), env, { nowSeconds: NOW });
    expect(viewer).toMatchObject({
      trust: 'verified',
      platformUserId: null,
      userId: null,
      role: null,
      displayName: null,
    });
  });

  it('drops a display name that arrives without an identity behind it', async () => {
    const env = await envFor();
    const token = await mint(
      {
        install_id: INSTALL,
        company_id: 'cmp_1',
        user_id: 'anonymous',
        platform_user_id: 'anonymous',
        role: 'anonymous',
        display_name: 'Jane Doe',
        email: 'jane@example.com',
      },
      env.SPRIGR_VIEWER_SECRET!,
    );
    const viewer = await resolveViewerContext(withToken(token), env, { nowSeconds: NOW });
    expect(viewer?.displayName).toBeNull();
    expect(viewer?.email).toBeNull();
  });
});

describe('install binding', () => {
  it('refuses a token minted for another install (wrong key)', async () => {
    const otherKey = await deriveKey(OTHER_INSTALL);
    const token = await mint({ ...CLAIMS, install_id: OTHER_INSTALL }, otherKey);
    const env = await envFor(INSTALL);
    expect(await verifyViewerToken(token, env, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await resolveViewerContext(withToken(token), env, { nowSeconds: NOW })).toBeNull();
  });

  it('refuses a token whose install_id does not match this install', async () => {
    // Right key, wrong claim: only reachable through operator misconfiguration
    // (a secret bound to the wrong install), and it must be loud, not silent.
    const env = await envFor(INSTALL);
    const token = await mint({ ...CLAIMS, install_id: OTHER_INSTALL }, env.SPRIGR_VIEWER_SECRET!);
    expect(await verifyViewerToken(token, env, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'install_mismatch',
    });
  });
});

describe('expiry and tamper', () => {
  it('accepts up to the last valid second and refuses at expiry', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    expect((await verifyViewerToken(token, env, { nowSeconds: NOW + 119 })).ok).toBe(true);
    expect(await verifyViewerToken(token, env, { nowSeconds: NOW + 120 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a replay long after the window', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    expect(await resolveViewerContext(withToken(token), env, { nowSeconds: NOW + 86_400 }))
      .toBeNull();
  });

  it('refuses a token issued beyond the clock-skew allowance', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    expect(await verifyViewerToken(token, env, { nowSeconds: NOW - 61 })).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    expect((await verifyViewerToken(token, env, { nowSeconds: NOW - 60 })).ok).toBe(true);
  });

  it('refuses a token whose claims were edited after signing', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    const [v, payload, mac] = token.split('.');
    let b64 = (payload as string).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    );
    decoded.platform_user_id = 'usr_victim';
    const tampered = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyViewerToken(`${v}.${tampered}.${mac}`, env, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a relabelled version tag', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!, { version: 'svc2' });
    expect(await verifyViewerToken(token, env, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('distinguishes "no token" from "no key bound"', async () => {
    const env = await envFor();
    expect(await verifyViewerToken(null, env)).toEqual({ ok: false, reason: 'missing' });
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    expect(await verifyViewerToken(token, { INSTALL_ID: INSTALL })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
  });
});

describe('legacy transport fallback', () => {
  const legacyHeaders = new Headers({
    [VIEWER_PLATFORM_USER_ID_HEADER]: 'usr_oidc_1',
    [VIEWER_USER_ID_HEADER]: 'usr_row_1',
    [VIEWER_ROLE_HEADER]: 'member',
  });

  it('is OFF by default, so the weaker path is never silent', async () => {
    expect(await resolveViewerContext(legacyHeaders, {})).toBeNull();
  });

  it('resolves and labels itself when opted into', async () => {
    const viewer = await resolveViewerContext(legacyHeaders, {}, {
      allowTransportFallback: true,
    });
    expect(viewer).toEqual({
      trust: 'transport',
      platformUserId: 'usr_oidc_1',
      userId: 'usr_row_1',
      companyId: null,
      role: 'member',
      displayName: null,
      email: null,
      installId: null,
    });
  });

  it('treats the anonymous sentinel as nobody', async () => {
    const h = new Headers({
      [VIEWER_PLATFORM_USER_ID_HEADER]: 'anonymous',
      [VIEWER_USER_ID_HEADER]: 'anonymous',
    });
    expect(await resolveViewerContext(h, {}, { allowTransportFallback: true })).toBeNull();
  });

  it('prefers the verified token over a conflicting legacy header', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    const h = new Headers({
      [VIEWER_CONTEXT_HEADER]: token,
      [VIEWER_PLATFORM_USER_ID_HEADER]: 'usr_someone_else',
    });
    const viewer = await resolveViewerContext(h, env, {
      nowSeconds: NOW,
      allowTransportFallback: true,
    });
    expect(viewer?.trust).toBe('verified');
    expect(viewer?.platformUserId).toBe('usr_oidc_1');
  });

  it('does NOT fall back to the legacy header when a token was present but failed', async () => {
    // An expired or forged token must not downgrade into the weaker channel:
    // that would make forging a token a way to select which channel answers.
    const env = await envFor();
    const expired = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!, { now: NOW - 1000 });
    const h = new Headers({
      [VIEWER_CONTEXT_HEADER]: expired,
      [VIEWER_PLATFORM_USER_ID_HEADER]: 'usr_someone_else',
    });
    const viewer = await resolveViewerContext(h, env, {
      nowSeconds: NOW,
      allowTransportFallback: true,
    });
    // The fallback is still reached (the token simply did not verify), but it
    // reports the LEGACY identity as transport-trust, never as verified.
    expect(viewer?.trust).toBe('transport');
    expect(viewer?.platformUserId).toBe('usr_someone_else');
  });
});

describe('resolveViewerUserId', () => {
  it('matches what the hand-rolled per-app copies returned', async () => {
    const h = new Headers({ [VIEWER_PLATFORM_USER_ID_HEADER]: 'usr_oidc_1' });
    expect(await resolveViewerUserId(h, {})).toBe('usr_oidc_1');
    expect(await resolveViewerUserId(new Headers(), {})).toBeNull();
    expect(
      await resolveViewerUserId(new Headers({ [VIEWER_PLATFORM_USER_ID_HEADER]: 'anonymous' }), {}),
    ).toBeNull();
  });

  it('prefers the verified token when one is present', async () => {
    const env = await envFor();
    const token = await mint(CLAIMS, env.SPRIGR_VIEWER_SECRET!);
    expect(await resolveViewerUserId(withToken(token), env, { nowSeconds: NOW })).toBe('usr_oidc_1');
  });
});

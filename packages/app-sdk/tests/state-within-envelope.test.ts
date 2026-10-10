/**
 * encodeStateWithinEnvelope: an app's OAuth state must leave room for the
 * platform's signed envelope (sprigr-team decision 0190), or the platform
 * sends it unsigned and a slug on the bouncer's enforce list refuses the
 * connect (sprigr-apps#3190). An optional field that does not fit is left
 * out WHOLE, never cut: a cut returnTo is a broken landing page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeState,
  encodeState,
  encodeStateWithinEnvelope,
  OAUTH_STATE_ENVELOPE_MAX_CHARS,
  oauthStateEnvelopeOverhead,
} from '../src/state';

const INSTALL = 'inst_abcdefghijklmnopqrst'; // 25 chars, the platform's id length
const IAT = 1791600000000; // a 13-digit ms timestamp, as the envelope's `t`

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The envelope exactly as sprigr-team mints it
 * (packages/shared/src/utils/oauth-state-envelope.ts, mintOAuthStateEnvelope):
 * `sps1.<inner>.<payload>.<sig>`, payload = base64url JSON {i, a, t}, sig =
 * the first 16 bytes of HMAC-SHA256 over "oauth-state-v1.<inner>.<payload>".
 */
async function platformEnvelope(inner: string, installId: string, appSlug: string, t: number): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ i: installId, a: appSlug, t })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`oauth-state-v1.${inner}.${payload}`));
  return `sps1.${inner}.${payload}.${b64url(new Uint8Array(mac).slice(0, 16))}`;
}

afterEach(() => vi.restoreAllMocks());

describe('oauthStateEnvelopeOverhead', () => {
  it.each(['trello', 'quickbooks', 'google-search-console', 'a-much-longer-marketplace-app-slug'])(
    'matches the length the platform adds around the inner state (%s)',
    async (slug) => {
      const inner = encodeState({ installId: INSTALL, csrf: 'c'.repeat(32), iat: IAT });
      const envelope = await platformEnvelope(inner, INSTALL, slug, IAT);
      expect(oauthStateEnvelopeOverhead(INSTALL, slug, IAT)).toBe(envelope.length - inner.length);
    },
  );

  it('leaves trello 385 characters of inner state, as measured on sprigr-apps#3190', () => {
    expect(OAUTH_STATE_ENVELOPE_MAX_CHARS - oauthStateEnvelopeOverhead(INSTALL, 'trello', IAT)).toBe(385);
  });
});

describe('encodeStateWithinEnvelope', () => {
  const base = { installId: INSTALL, csrf: 'c'.repeat(32), iat: IAT };
  const opts = { installId: INSTALL, appSlug: 'trello' };

  it('keeps a returnTo that fits, and the result is the plain encodeState output', () => {
    const state = { ...base, returnTo: '/acme/dashboard/apps/installed/inst_1/settings' };
    const out = encodeStateWithinEnvelope(state, opts);
    expect(out).toEqual({ state: encodeState(state), omitted: [], fits: true });
  });

  it('leaves an over-long returnTo out WHOLE and keeps every other field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longPath = '/acme/dashboard/' + 'x'.repeat(600);
    const out = encodeStateWithinEnvelope({ ...base, returnTo: longPath }, opts);
    const decoded = decodeState(out.state);
    expect(decoded).toEqual(base);
    expect('returnTo' in decoded).toBe(false);
    expect(out.omitted).toEqual(['returnTo']);
    expect(out.fits).toBe(true);
    expect(out.state.length).toBeLessThanOrEqual(OAUTH_STATE_ENVELOPE_MAX_CHARS - oauthStateEnvelopeOverhead(INSTALL, 'trello', IAT));
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain('returnTo');
    expect(msg).toContain(String(longPath.length)); // the omitted field's length
    expect(msg).toContain(String(encodeState({ ...base, returnTo: longPath }).length)); // the state's length with it
  });

  it('never emits a shortened returnTo: it is either the caller value exactly or absent', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let n = 0; n <= 400; n += 7) {
      const returnTo = '/' + 'p'.repeat(n);
      const decoded = decodeState(encodeStateWithinEnvelope({ ...base, returnTo }, opts).state);
      if ('returnTo' in decoded) expect(decoded.returnTo).toBe(returnTo);
    }
  });

  it('the cut-off is exact: the longest returnTo that fits is kept, one more character is omitted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = OAUTH_STATE_ENVELOPE_MAX_CHARS - oauthStateEnvelopeOverhead(INSTALL, 'trello', IAT);
    let longestKept = -1;
    for (let n = 0; n <= 400; n++) {
      const st = { ...base, returnTo: '/' + 'p'.repeat(n) };
      const out = encodeStateWithinEnvelope(st, opts);
      if (out.omitted.length === 0) {
        expect(encodeState(st).length).toBeLessThanOrEqual(budget);
        longestKept = n;
      } else {
        expect(encodeState(st).length).toBeGreaterThan(budget);
      }
    }
    expect(longestKept).toBeGreaterThan(0);
  });

  it('drops optional fields in the order given, stopping as soon as the state fits', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { ...base, actorPlatformUserId: 'usr_' + 'u'.repeat(20), returnTo: '/' + 'r'.repeat(400) };
    const out = encodeStateWithinEnvelope(state, { ...opts, optional: ['returnTo', 'actorPlatformUserId'] });
    expect(out.omitted).toEqual(['returnTo']);
    expect(decodeState(out.state).actorPlatformUserId).toBe(state.actorPlatformUserId);
  });

  it('when even the required fields overflow, it returns the state unchanged with fits: false and says it will go unsigned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { ...base, buildUrl: 'https://' + 'b'.repeat(500) + '.example.com', returnTo: '/settings' };
    const out = encodeStateWithinEnvelope(state, opts);
    expect(out).toEqual({ state: encodeState(state), omitted: [], fits: false });
    expect(String(warn.mock.calls[0]![0])).toMatch(/unsigned/);
  });

  it('defaults the optional list to returnTo only', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { ...base, actorAgentId: 'agt_' + 'a'.repeat(20), returnTo: '/' + 'r'.repeat(500) };
    const out = encodeStateWithinEnvelope(state, opts);
    expect(out.omitted).toEqual(['returnTo']);
    expect(decodeState(out.state).actorAgentId).toBe(state.actorAgentId);
  });

  it('measures against the real install id and slug: a longer slug leaves less room', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const returnTo = '/' + 'p'.repeat(149); // fits trello's 385, not a 60-char slug's 313
    const st = { ...base, returnTo };
    expect(encodeStateWithinEnvelope(st, { installId: INSTALL, appSlug: 'trello' }).omitted).toEqual([]);
    expect(encodeStateWithinEnvelope(st, { installId: INSTALL, appSlug: 'g'.repeat(60) }).omitted).toEqual(['returnTo']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  agentFileKeyFromUrl,
  appKeyFromCallerKey,
  callerKeyRefusal,
  readableStoredKey,
} from '../src/index';

/**
 * Keys and links shaped like the live ones from the 2026-10-01 shakedowns
 * (sprigr/sprigr-apps#2394): microsoft-365 handed out `onedrive/reads/<item>.docx`,
 * google-workspace `drive/reads/<file>.docx`, and the readable key was the
 * minted link's path.
 */
const INSTALL = 'inst_3fj8axd3f4jtnhkz8k2i';
const OWNER = 'a84aecf796334d794fab401aa9a8b344';
const APP_KEY = 'drive/reads/1y3N-JCtOTg6it9rm8J42hLZ6BZlEs8S1.docx';
const OWNED = `_apps/${INSTALL}/~u/${OWNER}/${APP_KEY}`;
const SHARED = `_apps/${INSTALL}/${APP_KEY}`;
const link = (key: string) =>
  `https://staging-files.sprigr.com/${key}?token=abc123&expires=1822400208&gen=0&mint_site=wfp-files`;

describe('agentFileKeyFromUrl', () => {
  it('reads the absolute key of a per-user copy off its link', () => {
    expect(agentFileKeyFromUrl(link(OWNED), APP_KEY)).toBe(OWNED);
  });

  it('reads the absolute key of a shared copy off its link', () => {
    expect(agentFileKeyFromUrl(link(SHARED), APP_KEY)).toBe(SHARED);
  });

  it('decodes an encoded path and ignores a leading slash on the app key', () => {
    const encoded = `_apps/${INSTALL}/~u/${OWNER}/drive/reads/Job%20Register.xlsx`;
    expect(agentFileKeyFromUrl(link(encoded), '/drive/reads/Job Register.xlsx')).toBe(
      `_apps/${INSTALL}/~u/${OWNER}/drive/reads/Job Register.xlsx`,
    );
  });

  it('returns null when the link is for a different app key', () => {
    expect(agentFileKeyFromUrl(link(OWNED), 'drive/reads/other.docx')).toBeNull();
  });

  it('returns null for a key that only ends with the app key (no partial-segment match)', () => {
    expect(agentFileKeyFromUrl(link(`_apps/${INSTALL}/xdrive/reads/a.docx`), 'drive/reads/a.docx')).toBeNull();
  });

  it('returns null for a path outside _apps/, an empty app key, or a non-URL', () => {
    expect(agentFileKeyFromUrl(link(`comp_x/agt_y/files/${APP_KEY}`), APP_KEY)).toBeNull();
    expect(agentFileKeyFromUrl(link(OWNED), '')).toBeNull();
    expect(agentFileKeyFromUrl('not a url', APP_KEY)).toBeNull();
  });

  it('returns null when the owner segment has no hash', () => {
    expect(agentFileKeyFromUrl(link(`_apps/${INSTALL}/~u/${APP_KEY}`), APP_KEY)).toBeNull();
  });
});

describe('readableStoredKey', () => {
  it('prefers the absolute key and falls back to the app key', () => {
    expect(readableStoredKey(APP_KEY, link(OWNED))).toBe(OWNED);
    expect(readableStoredKey(APP_KEY, 'https://example.com/elsewhere')).toBe(APP_KEY);
  });
});

describe('appKeyFromCallerKey', () => {
  it('passes an app-relative key through unchanged', () => {
    expect(appKeyFromCallerKey(APP_KEY, INSTALL)).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: false });
  });

  it('strips the install root and the owner segment from an absolute key', () => {
    expect(appKeyFromCallerKey(OWNED, INSTALL)).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: true });
    expect(appKeyFromCallerKey(SHARED, INSTALL)).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: true });
  });

  it('accepts the signed link itself', () => {
    expect(appKeyFromCallerKey(link(OWNED), INSTALL)).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: true });
  });

  it('drops a bare owner segment a caller left on after stripping the root', () => {
    expect(appKeyFromCallerKey(`~u/${OWNER}/${APP_KEY}`, INSTALL)).toEqual({
      ok: true,
      appKey: APP_KEY,
      wasAbsolute: true,
    });
  });

  it('accepts another owner\'s key as the app key: the platform resolves the owner from the caller', () => {
    const r = appKeyFromCallerKey(`_apps/${INSTALL}/~u/ffffffffffffffffffffffffffffffff/${APP_KEY}`, INSTALL);
    expect(r).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: true });
  });

  it('refuses an absolute key from a different install when this install is known', () => {
    const r = appKeyFromCallerKey(`_apps/inst_other/${APP_KEY}`, INSTALL);
    expect(r).toEqual({ ok: false, reason: 'other_install', installId: 'inst_other' });
    if (!r.ok) expect(callerKeyRefusal('k', r)).toContain('inst_other');
  });

  it('accepts an absolute key when this install is not known (the platform still confines it)', () => {
    expect(appKeyFromCallerKey(`_apps/inst_other/${APP_KEY}`, undefined)).toEqual({
      ok: true,
      appKey: APP_KEY,
      wasAbsolute: true,
    });
  });

  it('refuses an _apps/ key or link with no file path', () => {
    expect(appKeyFromCallerKey(`_apps/${INSTALL}/`, INSTALL)).toEqual({ ok: false, reason: 'malformed' });
    expect(appKeyFromCallerKey(`_apps/${INSTALL}/~u/${OWNER}/`, INSTALL)).toEqual({ ok: false, reason: 'malformed' });
    expect(appKeyFromCallerKey('https://staging-files.sprigr.com/comp_x/file.pdf', INSTALL)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('round-trips: the key a store returns resolves back to the key it stored', () => {
    const handedOut = readableStoredKey(APP_KEY, link(OWNED));
    expect(appKeyFromCallerKey(handedOut, INSTALL)).toEqual({ ok: true, appKey: APP_KEY, wasAbsolute: true });
  });
});

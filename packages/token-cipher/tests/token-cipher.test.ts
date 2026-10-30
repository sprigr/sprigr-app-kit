/**
 * The shared token cipher (sprigr-app-kit#225): the surface the four
 * sprigr-apps copies exported, once. Pins open/seal in both modes, sealed
 * twice, a missing or wrong KEK, messages that name the field and never the
 * value, kek-bound, and the revoke helper gws used on disconnect/uninstall.
 */
import { describe, expect, it, vi } from 'vitest';
import { encryptValue, isEncryptedValue } from '@sprigr/apps-d1-kv';
import { revocableToken, tokenCipher, TokenKeyError, tokenKekBound } from '../src/index';

/** Platform-shaped KEKs. d1-kv refuses a KEK under 16 bytes. */
const KEK = btoa('0123456789abcdef0123456789abcdef');
const OTHER_KEK = btoa('fedcba9876543210fedcba9876543210');
const TOKEN = '1//0g-refresh-token-value';

type Field = 'gws_actor_tokens.access_token' | 'gws_actor_tokens.refresh_token';
const REFRESH: Field = 'gws_actor_tokens.refresh_token';
const ACCESS: Field = 'gws_actor_tokens.access_token';

const base = { binding: 'GOOGLE_WORKSPACE_TOKEN_KEK', provider: 'Google' } as const;
// `null` is "no key bound": a default parameter would turn undefined back into KEK.
const encrypting = (kek: string | null = KEK) => tokenCipher<Field>({ ...base, kek, mode: 'encrypt' });
const decryptOnly = (kek: string | null = KEK) => tokenCipher<Field>({ ...base, kek, mode: 'decrypt-only' });

async function errorOf(p: Promise<unknown>): Promise<TokenKeyError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TokenKeyError);
    return err as TokenKeyError;
  }
  throw new Error('expected a TokenKeyError');
}

describe('tokenCipher', () => {
  it('encrypt mode seals, and open gives the plaintext back', async () => {
    const sealed = await encrypting().seal(TOKEN);
    expect(sealed).not.toBe(TOKEN);
    expect(isEncryptedValue(sealed!)).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(await encrypting().open(sealed, REFRESH)).toBe(TOKEN);
  });

  it('decrypt-only mode stores cleartext but still opens a sealed value (the release A floor)', async () => {
    expect(await decryptOnly().seal(TOKEN)).toBe(TOKEN);
    const sealedElsewhere = await encryptValue(KEK, TOKEN);
    expect(await decryptOnly().open(sealedElsewhere, REFRESH)).toBe(TOKEN);
  });

  it('cleartext and null pass through open; null passes through seal', async () => {
    expect(await encrypting().open(TOKEN, ACCESS)).toBe(TOKEN);
    expect(await encrypting().open(null, ACCESS)).toBeNull();
    expect(await encrypting().open(undefined, ACCESS)).toBeNull();
    expect(await encrypting().seal(null)).toBeNull();
  });

  it('seal leaves an already-sealed value as it is', async () => {
    const sealed = await encrypting().seal(TOKEN);
    expect(await encrypting().seal(sealed)).toBe(sealed);
  });

  it('a sealed value with no KEK bound throws TokenKeyError naming the field and binding, never the value', async () => {
    const sealed = await encrypting().seal(TOKEN);
    const err = await errorOf(encrypting(null).open(sealed, REFRESH));
    expect(err.message).toContain(REFRESH);
    expect(err.message).toContain('GOOGLE_WORKSPACE_TOKEN_KEK');
    expect(err.message).toContain('Nothing was sent to Google; contact support.');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(sealed!);
  });

  it('a wrong KEK or an altered value throws TokenKeyError', async () => {
    const sealed = (await encrypting().seal(TOKEN))!;
    await errorOf(encrypting(OTHER_KEK).open(sealed, REFRESH));
    const altered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await errorOf(encrypting().open(altered, REFRESH));
  });

  it('sealed twice is refused rather than handed out as a token', async () => {
    const twice = await encryptValue(KEK, await encryptValue(KEK, TOKEN));
    const err = await errorOf(encrypting().open(twice, ACCESS));
    expect(err.message).toBe(`${ACCESS} is sealed twice. Nothing was sent to Google; contact support.`);
  });

  it('a seal with no usable KEK throws TokenKeyError in encrypt mode only', async () => {
    const err = await errorOf(encrypting(null).seal(TOKEN));
    expect(err.message).toMatch(/^this install's GOOGLE_WORKSPACE_TOKEN_KEK is missing or unusable, so a Google credential was not stored \(/);
    expect(err.message).toMatch(/\. Contact support\.$/);
    expect(err.message).not.toContain(TOKEN);
    expect(await decryptOnly(null).seal(TOKEN)).toBe(TOKEN);
  });

  it('the wording options carry the per-app differences', async () => {
    const github = tokenCipher<'github_token_cache.token'>({
      kek: undefined, binding: 'GITHUB_TOKEN_KEK', provider: 'GitHub', mode: 'encrypt',
      notKept: 'token was not cached', contactSupport: false,
    });
    const sealErr = await errorOf(github.seal(TOKEN));
    expect(sealErr.message).toContain('so a GitHub token was not cached (');
    expect(sealErr.message).not.toMatch(/contact support/i);
    const sealed = await encryptValue(KEK, TOKEN);
    const openErr = await errorOf(github.open(sealed, 'github_token_cache.token'));
    expect(openErr.message).toMatch(/Nothing was sent to GitHub\.$/);
  });
});

describe('tokenKekBound', () => {
  it('is true only for a non-blank string', () => {
    expect(tokenKekBound(KEK)).toBe(true);
    expect(tokenKekBound(undefined)).toBe(false);
    expect(tokenKekBound(null)).toBe(false);
    expect(tokenKekBound('')).toBe(false);
    expect(tokenKekBound('   ')).toBe(false);
  });
});

describe('revocableToken', () => {
  it('opens the refresh token first, else the access token', async () => {
    const c = encrypting();
    const refresh = await c.seal('rt-1');
    const access = await c.seal('at-1');
    const warn = vi.fn();
    expect(await revocableToken(c, [[refresh, REFRESH], [access, ACCESS]], warn)).toBe('rt-1');
    expect(await revocableToken(c, [[null, REFRESH], [access, ACCESS]], warn)).toBe('at-1');
    expect(await revocableToken(c, [[null, REFRESH], [null, ACCESS]], warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a sealed token this install cannot open gives null and reports the field, never a token', async () => {
    const sealed = await encrypting().seal('rt-1');
    const warn = vi.fn();
    expect(await revocableToken(encrypting(OTHER_KEK), [[sealed, REFRESH], ['at-1', ACCESS]], warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain(REFRESH);
    expect(msg).not.toContain('rt-1');
  });
});

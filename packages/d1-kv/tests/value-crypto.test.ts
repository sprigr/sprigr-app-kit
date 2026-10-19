import { describe, it, expect } from 'vitest';
import { encryptValue, decryptValue, isEncryptedValue, ENVELOPE_PREFIX } from '../src/index';

const KEK = 'dGVzdC10b2tlbi1rZWstMzItYnl0ZXMtbG9uZy0wMDA=';

describe('exported value crypto (sprigr-team#9825)', () => {
  it('seals a value into the envelope and opens it again', async () => {
    const sealed = await encryptValue(KEK, 'xoxb-secret');
    expect(sealed.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(isEncryptedValue(sealed)).toBe(true);
    expect(sealed).not.toContain('xoxb-secret');
    expect(await decryptValue(KEK, sealed, 'slack_settings.bot_token')).toBe('xoxb-secret');
  });

  it('passes a cleartext value through unchanged (read-both migration)', async () => {
    expect(await decryptValue(KEK, 'xoxb-legacy', 'slack_settings.bot_token')).toBe('xoxb-legacy');
  });

  it('refuses a wrong key without echoing the value or the ciphertext', async () => {
    const sealed = await encryptValue(KEK, 'xoxp-secret');
    const other = 'b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktMDA=';
    const err = await decryptValue(other, sealed, 'slack_user_tokens.user_token').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('slack_user_tokens.user_token');
    expect((err as Error).message).not.toContain('xoxp-secret');
    expect((err as Error).message).not.toContain(sealed.slice(ENVELOPE_PREFIX.length, ENVELOPE_PREFIX.length + 12));
  });
});

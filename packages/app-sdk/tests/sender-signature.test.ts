import { describe, it, expect, vi } from 'vitest';
import { withSenderSignature, type SprigrMeSignatureResult } from '../src/index';

const BODY = '<p>Order SO-1042 has shipped.</p>';
const SIG = '<p>Ana Ruiz | Ops</p>';
const me = (answer: SprigrMeSignatureResult | Error) => ({
  signature: vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; }),
});
const base = { html: BODY, channel: 'outlook_mail', senderPlatformUserId: 'usr_ana' };

describe('withSenderSignature (sprigr-team decision 0255)', () => {
  it('appends the sender\'s signature under a separator, asking for the given channel', async () => {
    const m = me({ ok: true, platform_user_id: 'usr_ana', html: SIG });
    expect(await withSenderSignature({ me: m }, base)).toBe(`${BODY}<br><br>-- <br>${SIG}`);
    expect(m.signature).toHaveBeenCalledWith({ channel: 'outlook_mail' });
  });

  it('leaves the body unchanged for another person, no signature, a refusal, an already-signed body, a throw, or no bridge', async () => {
    expect(await withSenderSignature({ me: me({ ok: true, platform_user_id: 'usr_bo', html: SIG }) }, base)).toBe(BODY);
    expect(await withSenderSignature({ me: me({ ok: true, platform_user_id: 'usr_ana', html: null }) }, base)).toBe(BODY);
    expect(await withSenderSignature({ me: me({ ok: false, error: 'no_person', message: 'nobody' }) }, base)).toBe(BODY);
    expect(await withSenderSignature({ me: me({ ok: true, platform_user_id: 'usr_ana', html: SIG }) }, { ...base, html: `${BODY}${SIG}` })).toBe(`${BODY}${SIG}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await withSenderSignature({ me: me(new Error('boom')) }, base)).toBe(BODY);
    warn.mockRestore();
    expect(await withSenderSignature({}, base)).toBe(BODY);
    expect(await withSenderSignature(undefined, base)).toBe(BODY);
  });

  it('never asks when there is no sender to compare against', async () => {
    const m = me({ ok: true, platform_user_id: 'usr_ana', html: SIG });
    expect(await withSenderSignature({ me: m }, { ...base, senderPlatformUserId: undefined })).toBe(BODY);
    expect(m.signature).not.toHaveBeenCalled();
  });
});

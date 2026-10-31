import { describe, it, expect } from 'vitest';
import { withMySignature } from '../src/lib/signature';
import type { SprigrMeSignatureResult } from '../src/lib/sprigr-host';

const host = (answer: SprigrMeSignatureResult) => ({ me: { signature: async () => answer } });
const BODY = '<p>Order SO-1042 has shipped.</p>';
const args = { html: BODY, channel: 'outlook_mail', mailboxOwnerPlatformUserId: 'usr_ana' };

describe('withMySignature (env.SPRIGR.me.signature, decision 0255)', () => {
  it('appends the mailbox owner\'s signature under a separator', async () => {
    const out = await withMySignature(host({ ok: true, platform_user_id: 'usr_ana', html: '<p>Ana</p>' }), args);
    expect(out).toBe(`${BODY}<br><br>-- <br><p>Ana</p>`);
  });

  it('sends the body unchanged for another person, no signature, a refusal, an already-signed body, or no capability', async () => {
    expect(await withMySignature(host({ ok: true, platform_user_id: 'usr_bo', html: '<p>Bo</p>' }), args)).toBe(BODY);
    expect(await withMySignature(host({ ok: true, platform_user_id: 'usr_ana', html: null }), args)).toBe(BODY);
    expect(await withMySignature(host({ ok: false, error: 'no_person', message: 'nobody' }), args)).toBe(BODY);
    expect(await withMySignature(host({ ok: true, platform_user_id: 'usr_ana', html: '<p>Order' }), args)).toBe(BODY);
    expect(await withMySignature({}, args)).toBe(BODY);
  });
});

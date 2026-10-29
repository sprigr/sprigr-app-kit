import { describe, expect, it } from 'vitest';
import { emailAudience } from '../../src/write-protection/approval-audience';
import { requireApproval, type ApprovalSpec } from '../../src/write-protection/require-approval';

describe('emailAudience (sprigr-team decision 0312)', () => {
  it('merges to, cc and bcc into lowercased, deduplicated bare addresses', () => {
    expect(emailAudience({ to: ['Fiq <Fiq@Example.com>', 'b@example.com'], cc: 'fiq@example.com; c@example.com', sender: 'actor' }))
      .toEqual({ recipients: ['fiq@example.com', 'b@example.com', 'c@example.com'], sender: 'actor' });
  });

  it('is undefined when nothing is sent to, or when any entry is not an address', () => {
    expect(emailAudience({ to: [], sender: 'actor' })).toBeUndefined();
    expect(emailAudience({ to: ['fiq@example.com', 'Team'], sender: 'actor' })).toBeUndefined();
  });

  it('is undefined over the platform limit, rather than a partial list', () => {
    const to = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect(emailAudience({ to, sender: 'actor' })).toBeUndefined();
  });

  it('reaches the envelope through ApprovalSpec.describe', async () => {
    const handlers = { send_mail: async () => ({ ok: true }) };
    const specs: Record<string, ApprovalSpec<object>> = {
      send_mail: {
        keys: ['to'],
        describe: (_t, a) => ({
          question: 'Send it?',
          header: 'Mail',
          audience: emailAudience({ to: a.to as string, sender: 'actor' }),
        }),
      },
    };
    const gated = requireApproval(handlers, specs, { scope: 'mail-test', resolveConnection: async () => '' });
    const out = (await gated.send_mail!({ to: 'Me@Example.com' }, {})) as { _approval?: { audience?: unknown } };
    expect(out._approval?.audience).toEqual({ recipients: ['me@example.com'], sender: 'actor' });
  });
});

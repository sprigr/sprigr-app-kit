import { describe, expect, it } from 'vitest';
import { emailPreview, fieldsPreview, smsPreview } from '../../src/write-protection/approval-preview';
import { requireApproval, type ApprovalSpec } from '../../src/write-protection/require-approval';

describe('approval preview builders (sprigr-team decision 0216)', () => {
  it('emailPreview binds slots to argument names, defaults html and irreversible', () => {
    expect(emailPreview({ from: { value: 'chris@example.com' }, to: 'to', cc: 'cc', subject: 'subject', body: 'body' })).toEqual({
      kind: 'email',
      from: { value: 'chris@example.com' },
      to: 'to',
      cc: 'cc',
      subject: 'subject',
      body: { arg: 'body', format: 'html' },
      facts: ['irreversible'],
    });
  });

  it('emailPreview takes dotted paths and a text body for a dispatcher', () => {
    const p = emailPreview({ to: 'input.customer_email', subject: 'input.subject', body: 'input.body', bodyFormat: 'text', facts: [] });
    expect(p.body).toEqual({ arg: 'input.body', format: 'text' });
    expect(p.facts).toEqual([]);
  });

  it("emailPreview passes bodyFormat 'auto' through for a tool that sends via emailBodyHtml", () => {
    expect(emailPreview({ to: 'to', body: 'body', bodyFormat: 'auto' }).body).toEqual({ arg: 'body', format: 'auto' });
  });

  it('smsPreview is a text body', () => {
    expect(smsPreview({ to: 'to', body: 'message', facts: ['irreversible', 'costs_credits'] })).toEqual({
      kind: 'sms',
      to: 'to',
      body: { arg: 'message', format: 'text' },
      facts: ['irreversible', 'costs_credits'],
    });
  });

  it('fieldsPreview lists rows', () => {
    expect(fieldsPreview('document', [{ label: 'Invoice', from: 'invoice_id' }], { to: { value: 'billing@acme.test' } })).toEqual({
      kind: 'document',
      to: { value: 'billing@acme.test' },
      fields: [{ label: 'Invoice', from: 'invoice_id' }],
    });
  });

  it('a spec describe() can return a preview, and requireApproval puts it on the envelope', async () => {
    const handlers = { send_mail: async () => ({ ok: true }) };
    const specs: Record<string, ApprovalSpec<object>> = {
      send_mail: {
        keys: ['to'],
        describe: (_t, a, mailbox) => ({
          question: `Send an email to ${String(a.to)}?`,
          header: 'Mail',
          preview: emailPreview({ from: { value: mailbox }, to: 'to', subject: 'subject', body: 'body' }),
        }),
      },
    };
    const gated = requireApproval(handlers, specs, {
      scope: 'mail-test',
      resolveConnection: async () => 'chris@example.com',
    });
    const out = (await gated.send_mail!({ to: 'a@b.test', subject: 'Hi', body: '<p>x</p>' }, {})) as { _approval?: { preview?: unknown } };
    expect(out._approval?.preview).toMatchObject({ kind: 'email', from: { value: 'chris@example.com' }, body: { arg: 'body' } });
  });
});

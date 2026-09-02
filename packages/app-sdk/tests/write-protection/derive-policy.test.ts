import { describe, it, expect } from 'vitest';
import { commonDestructiveVerbs, deriveConfirmationPolicy, checkConfirmationPolicy } from '../../src/index';

const registry = ['list_jobs', 'create_job', 'delete_job', 'void_invoice', 'archive_contact', 'remove_job_material', 'cancel_booking', 'delete_draft_note'];

describe('deriveConfirmationPolicy', () => {
  it('classifies by verb, first rule wins, and phrases the describe from the rest of the name', () => {
    const { policy, unmatched, ungated } = deriveConfirmationPolicy(registry, { rules: commonDestructiveVerbs('in ServiceM8') });
    expect(Object.keys(policy.actions).sort()).toEqual(['archive_contact', 'cancel_booking', 'delete_draft_note', 'delete_job', 'remove_job_material', 'void_invoice']);
    expect(policy.actions.delete_job).toEqual({ always: true, irreversible: true, describe: 'Delete job in ServiceM8' });
    expect(policy.actions.remove_job_material).toEqual({ always: true, describe: 'Remove job material in ServiceM8' });
    expect(unmatched.sort()).toEqual(['create_job', 'list_jobs']);
    expect(ungated).toEqual([]);
  });

  it('exempt keeps a matching action ungated and reports it', () => {
    const { policy, ungated } = deriveConfirmationPolicy(registry, { rules: commonDestructiveVerbs(''), exempt: ['delete_draft_note'] });
    expect(policy.actions.delete_draft_note).toBeUndefined();
    expect(ungated).toEqual(['delete_draft_note']);
    expect(policy.actions.delete_job?.describe).toBe('Delete job');
  });

  it('overrides win over the verb table and keep their own wording', () => {
    const { policy } = deriveConfirmationPolicy(registry, {
      rules: commonDestructiveVerbs('in Xero'),
      overrides: { void_invoice: { always: true, irreversible: true, describe: 'Void invoice {input.id}, which Xero cannot un-void' } },
    });
    expect(policy.actions.void_invoice?.describe).toBe('Void invoice {input.id}, which Xero cannot un-void');
  });

  it('accepts a regex rule and spaces the whole name for it', () => {
    const { policy } = deriveConfirmationPolicy(['send_sms_to_client', 'get_client'], {
      rules: [{ match: /^send_sms/, tier: 'irreversible', describe: (_n, rest) => `Send an SMS (${rest})` }],
    });
    expect(policy.actions.send_sms_to_client?.describe).toBe('Send an SMS (send sms to client)');
  });

  it('produces a policy the checker accepts as-is', () => {
    const { policy, ungated } = deriveConfirmationPolicy(registry, { rules: commonDestructiveVerbs('') });
    expect(checkConfirmationPolicy({ policy, registry, ungated: [...ungated, 'create_job'], nestedUnderInput: true })).toEqual([]);
  });
});

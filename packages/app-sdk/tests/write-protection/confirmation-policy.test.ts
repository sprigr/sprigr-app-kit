import { describe, expect, it } from 'vitest';
import { buildConfirmationPolicy, checkConfirmationPolicy } from '../../src/write-protection/confirmation-policy';

const registry = ['list_invoices', 'create_invoice', 'void_invoice', 'create_contact', 'authorise_invoices', 'create_payment'];
const required = (a: string) => ({ void_invoice: ['id'], authorise_invoices: [], create_payment: ['invoice_id'] } as Record<string, string[]>)[a];

describe('buildConfirmationPolicy', () => {
  it('sorts actions and stamps the group semantics', () => {
    const p = buildConfirmationPolicy({
      irreversible: { void_invoice: 'Void invoice {input.id}' },
      always: { create_invoice: 'Create an invoice' },
      rules: { authorise_invoices: { when: { count: 'input.ids', atLeast: 10 }, describe: 'Authorise {input.ids.length} invoices' } },
    });
    expect(Object.keys(p.actions!)).toEqual(['authorise_invoices', 'create_invoice', 'void_invoice']);
    expect(p.actions!.void_invoice).toEqual({ always: true, irreversible: true, describe: 'Void invoice {input.id}' });
    expect(p.actions!.create_invoice).toEqual({ always: true, describe: 'Create an invoice' });
  });

  it('refuses an action declared in two groups', () => {
    expect(() => buildConfirmationPolicy({ always: { a: 'x' }, irreversible: { a: 'y' } })).toThrow(/declared twice/);
  });
});

describe('checkConfirmationPolicy', () => {
  it('passes a well-formed policy with every write classified', () => {
    const policy = buildConfirmationPolicy({
      irreversible: { void_invoice: 'Void invoice {input.id}' },
      always: { create_invoice: 'Create an invoice', create_payment: 'Record a payment against invoice {input.invoice_id}' },
      rules: { authorise_invoices: { when: { count: 'input.ids', atLeast: 10 }, describe: 'Authorise {input.ids.length} invoices' } },
    });
    expect(checkConfirmationPolicy({ policy, registry, ungated: ['create_contact'], requiredInput: required })).toEqual([]);
  });

  it('names every silent failure', () => {
    const policy = buildConfirmationPolicy({
      irreversible: { void_invoce: 'Void invoice {id}.' },
      rules: {
        create_payment: { when: { count: 'input.amount', atLeast: 0 } },
        authorise_invoices: { always: true, describe: 'Authorise {input.ids.length}' },
      },
    });
    const findings = checkConfirmationPolicy({ policy, registry, ungated: ['create_contact', 'ghost', 'authorise_invoices'], requiredInput: required });
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringMatching(/dead rule: "void_invoce"/),
      expect.stringMatching(/void_invoce: describe must not end in a period/),
      expect.stringMatching(/void_invoce: placeholder \{id\} is not under input\./),
      expect.stringMatching(/create_payment: atLeast must be >= 1/),
      expect.stringMatching(/create_payment: threshold on money field/),
      expect.stringMatching(/create_payment: describe missing/),
      expect.stringMatching(/authorise_invoices: placeholder \{input\.ids\.length\} reads "ids", which the action does not require/),
      expect.stringMatching(/ungated list: "ghost" is not in the registry/),
      expect.stringMatching(/ungated list: "authorise_invoices" is also gated/),
      expect.stringMatching(/unclassified write: "create_invoice"/),
    ]));
    expect(findings.some((f) => f.includes('void_invoice') && f.includes('unclassified'))).toBe(true);
  });

  it('a flat (non-nested) dispatcher may use bare placeholders', () => {
    const policy = buildConfirmationPolicy({ always: { create_invoice: 'Create invoice {contact_id}' } });
    const findings = checkConfirmationPolicy({ policy, registry: ['create_invoice'], nestedUnderInput: false });
    expect(findings).toEqual([]);
  });
});

describe('attended: approval_card (sprigr-team decision 0167)', () => {
  const src = {
    irreversible: { delete_job: 'Delete job {input.uuid}' },
    always: { update_job: 'Update job {input.uuid}', send_sms: 'Send an SMS to {input.to}' },
  };

  it('stamps the key on gated actions an approval spec covers, and only those', () => {
    const policy = buildConfirmationPolicy({ ...src, approvalCovered: ['delete_job', 'send_sms', 'record_payment'] });
    expect(policy.actions?.delete_job?.attended).toBe('approval_card');
    expect(policy.actions?.send_sms?.attended).toBe('approval_card');
    expect(policy.actions?.update_job?.attended).toBeUndefined();
    // A spec with no rule stays without one: it already asks once.
    expect(policy.actions?.record_payment).toBeUndefined();
  });

  const registry = ['delete_job', 'update_job', 'send_sms'];

  it('passes a policy built from the same specs it is checked against', () => {
    const covered = ['delete_job', 'send_sms'];
    const policy = buildConfirmationPolicy({ ...src, approvalCovered: covered });
    expect(checkConfirmationPolicy({ policy, registry, approvalCovered: covered })).toEqual([]);
  });

  it('fails a covered, gated action that lacks the key (it asks twice)', () => {
    const policy = buildConfirmationPolicy(src);
    expect(checkConfirmationPolicy({ policy, registry, approvalCovered: ['delete_job'] }))
      .toEqual(["delete_job: an approval spec covers it but the rule lacks attended: 'approval_card', so it asks twice"]);
  });

  it('fails a key no spec covers (it removes the only prompt)', () => {
    const policy = buildConfirmationPolicy({ ...src, approvalCovered: ['update_job'] });
    expect(checkConfirmationPolicy({ policy, registry, approvalCovered: [] }))
      .toEqual(["update_job: attended: 'approval_card' but no approval spec covers it, so it removes the only prompt"]);
  });

  it('fails a key it cannot vouch for when approvalCovered is not passed', () => {
    const policy = buildConfirmationPolicy({ ...src, approvalCovered: ['delete_job'] });
    expect(checkConfirmationPolicy({ policy, registry }))
      .toEqual(["delete_job: attended: 'approval_card' cannot be checked; pass approvalCovered (the approval spec keys)"]);
  });

  it('fails a value the platform would ignore', () => {
    const policy = { actions: { delete_job: { always: true, describe: 'Delete', attended: 'card' as never } } };
    expect(checkConfirmationPolicy({ policy, registry: ['delete_job'], approvalCovered: ['delete_job'] }))
      .toEqual([`delete_job: attended must be 'approval_card' (got "card"); the platform ignores anything else`]);
  });

  it('leaves a policy with no keys and no approvalCovered exactly as before', () => {
    expect(checkConfirmationPolicy({ policy: buildConfirmationPolicy(src), registry })).toEqual([]);
  });
});

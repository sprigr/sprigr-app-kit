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
  const registry = ['delete_job', 'update_job', 'send_sms'];
  const none: string[] = [];

  it('stamps the key on gated, unconditional actions an approval spec covers, and only those', () => {
    const policy = buildConfirmationPolicy({
      ...src,
      approval: { covered: ['delete_job', 'send_sms', 'record_payment'], conditional: none },
    });
    expect(policy.actions?.delete_job?.attended).toBe('approval_card');
    expect(policy.actions?.send_sms?.attended).toBe('approval_card');
    expect(policy.actions?.update_job?.attended).toBeUndefined();
    // A spec with no rule stays without one: it already asks once.
    expect(policy.actions?.record_payment).toBeUndefined();
  });

  it('never stamps an action the app gates conditionally', () => {
    const policy = buildConfirmationPolicy({ ...src, approval: { covered: ['delete_job', 'send_sms'], conditional: ['delete_job'] } });
    expect(policy.actions?.delete_job?.attended).toBeUndefined();
    expect(policy.actions?.send_sms?.attended).toBe('approval_card');
  });

  it('refuses coverage that omits conditional', () => {
    expect(() => buildConfirmationPolicy({ ...src, approval: { covered: ['delete_job'] } as never })).toThrow(/conditional/);
    expect(() => checkConfirmationPolicy({ policy: buildConfirmationPolicy(src), registry, approval: { covered: [] } as never }))
      .toThrow(/conditional/);
  });

  it('passes a policy built from the same coverage it is checked against', () => {
    const approval = { covered: ['delete_job', 'send_sms'], conditional: ['delete_job'] };
    const policy = buildConfirmationPolicy({ ...src, approval });
    expect(checkConfirmationPolicy({ policy, registry, approval })).toEqual([]);
  });

  it('fails a covered, unconditional, gated action that lacks the key (it asks twice)', () => {
    const policy = buildConfirmationPolicy(src);
    expect(checkConfirmationPolicy({ policy, registry, approval: { covered: ['delete_job'], conditional: none } }))
      .toEqual(["delete_job: an approval spec covers it but the rule lacks attended: 'approval_card', so it asks twice"]);
  });

  it('fails the key on a conditionally gated action (no prompt at all on a call that skips the card)', () => {
    const policy = buildConfirmationPolicy({ ...src, approval: { covered: ['delete_job'], conditional: none } });
    expect(checkConfirmationPolicy({ policy, registry, approval: { covered: ['delete_job'], conditional: ['delete_job'] } }))
      .toEqual(["delete_job: attended: 'approval_card' on a conditionally gated action, so a call that skips the card gets no prompt at all"]);
  });

  it('fails a key no spec covers (it removes the only prompt)', () => {
    const policy = buildConfirmationPolicy({ ...src, approval: { covered: ['update_job'], conditional: none } });
    expect(checkConfirmationPolicy({ policy, registry, approval: { covered: [], conditional: none } }))
      .toEqual(["update_job: attended: 'approval_card' but no approval spec covers it, so it removes the only prompt"]);
  });

  it('fails a conditional entry with no spec', () => {
    const policy = buildConfirmationPolicy(src);
    expect(checkConfirmationPolicy({ policy, registry, approval: { covered: [], conditional: ['delete_job'] } }))
      .toEqual(['approval.conditional: "delete_job" has no approval spec (not in covered)']);
  });

  it('fails a key it cannot vouch for when no coverage is passed', () => {
    const policy = buildConfirmationPolicy({ ...src, approval: { covered: ['delete_job'], conditional: none } });
    expect(checkConfirmationPolicy({ policy, registry }))
      .toEqual(["delete_job: attended: 'approval_card' cannot be checked; pass approval: { covered, conditional }"]);
  });

  it('fails a value the platform would ignore', () => {
    const policy = { actions: { delete_job: { always: true, describe: 'Delete', attended: 'card' as never } } };
    expect(checkConfirmationPolicy({ policy, registry: ['delete_job'], approval: { covered: ['delete_job'], conditional: none } }))
      .toEqual([`delete_job: attended must be 'approval_card' (got "card"); the platform ignores anything else`]);
  });

  it('leaves a policy with no keys and no coverage exactly as before', () => {
    expect(checkConfirmationPolicy({ policy: buildConfirmationPolicy(src), registry })).toEqual([]);
  });
});

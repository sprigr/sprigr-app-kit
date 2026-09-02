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

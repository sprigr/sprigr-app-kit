/**
 * `deliversMessage` on action rules (sprigr-app-kit#303, sprigr-team decision
 * 0414): `noMessage` on the policy builders stamps `false` on a COPY of each
 * named action's rule, and `checkConfirmationPolicy` flags the shapes publish
 * rejects. The `never` narrowing on `ConfirmationPolicy` is type-only; case 7
 * covers the runtime rejection of a top-level key.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConfirmationPolicy,
  checkConfirmationPolicy,
  commonDestructiveVerbs,
  deriveConfirmationPolicy,
  type ConfirmRule,
  type ConfirmationPolicy,
} from '../../src/index';

describe('noMessage on buildConfirmationPolicy', () => {
  it('1. stamps deliversMessage false on the named action only', () => {
    const p = buildConfirmationPolicy({
      irreversible: { refund_order: 'Refund the order' },
      always: { archive_order: 'Archive the order' },
      noMessage: ['refund_order'],
    });
    expect(p.actions!.refund_order).toEqual({ always: true, describe: 'Refund the order', irreversible: true, deliversMessage: false });
    expect('deliversMessage' in p.actions!.archive_order!).toBe(false);
  });

  it('2. stamps a copy of a rules entry and leaves the caller\'s object unchanged', () => {
    const rule: ConfirmRule = { always: true, describe: 'Adjust stock' };
    const p = buildConfirmationPolicy({ rules: { adjust_stock: rule }, noMessage: ['adjust_stock'] });
    expect(p.actions!.adjust_stock!.deliversMessage).toBe(false);
    expect(p.actions!.adjust_stock).not.toBe(rule);
    expect(rule).toEqual({ always: true, describe: 'Adjust stock' });
  });

  it('3. a covered action carries attended and then deliversMessage', () => {
    const p = buildConfirmationPolicy({
      irreversible: { delete_unit: 'Delete the unit' },
      approval: { covered: ['delete_unit'], conditional: [] },
      noMessage: ['delete_unit'],
    });
    expect(Object.keys(p.actions!.delete_unit!)).toEqual(['always', 'describe', 'irreversible', 'attended', 'deliversMessage']);
    expect(p.actions!.delete_unit!.attended).toBe('approval_card');
    expect(p.actions!.delete_unit!.deliversMessage).toBe(false);
  });

  it('4. throws on a noMessage name that has no rule', () => {
    expect(() => buildConfirmationPolicy({ always: { archive_order: 'Archive the order' }, noMessage: ['refund_ordr'] })).toThrow(/refund_ordr/);
  });

  it('5. throws on a noMessage name whose rule says it delivers a message', () => {
    expect(() =>
      buildConfirmationPolicy({
        rules: { notify_customer: { always: true, describe: 'Notify the customer', deliversMessage: true } },
        noMessage: ['notify_customer'],
      }),
    ).toThrow(/notify_customer/);
  });

  it('8. a name given twice behaves as once', () => {
    const src = { irreversible: { refund_order: 'Refund the order' } };
    const once = buildConfirmationPolicy({ ...src, noMessage: ['refund_order'] });
    let twice: ConfirmationPolicy | undefined;
    expect(() => {
      twice = buildConfirmationPolicy({ ...src, noMessage: ['refund_order', 'refund_order'] });
    }).not.toThrow();
    expect(twice).toEqual(once);
  });

  it('9. an empty noMessage changes nothing', () => {
    const src = { irreversible: { refund_order: 'Refund the order' }, always: { archive_order: 'Archive the order' } };
    expect(buildConfirmationPolicy({ ...src, noMessage: [] })).toEqual(buildConfirmationPolicy(src));
  });
});

describe('noMessage on deriveConfirmationPolicy', () => {
  it('6. passes noMessage through, and an exempt name in it throws', () => {
    const registry = ['delete_unit', 'archive_unit', 'list_units'];
    const { policy } = deriveConfirmationPolicy(registry, { rules: commonDestructiveVerbs('in Example'), noMessage: ['delete_unit'] });
    expect(policy.actions.delete_unit!.deliversMessage).toBe(false);
    expect('deliversMessage' in policy.actions.archive_unit!).toBe(false);
    expect(() =>
      deriveConfirmationPolicy(registry, { rules: commonDestructiveVerbs('in Example'), exempt: ['archive_unit'], noMessage: ['archive_unit'] }),
    ).toThrow(/archive_unit/);
  });
});

describe('deliversMessage in checkConfirmationPolicy', () => {
  const registry = ['delete_unit'];
  const actions = { delete_unit: { always: true, irreversible: true, describe: 'Delete the unit' } };

  it('7. flags the key on the tool-level rule and a non-boolean action value', () => {
    const topLevel = { deliversMessage: false, actions } as unknown as ConfirmationPolicy;
    expect(checkConfirmationPolicy({ policy: topLevel, registry })).toEqual([expect.stringContaining('deliversMessage')]);
    const notBoolean = { actions: { delete_unit: { ...actions.delete_unit, deliversMessage: 'no' } } } as unknown as ConfirmationPolicy;
    expect(checkConfirmationPolicy({ policy: notBoolean, registry })).toEqual([expect.stringContaining('delete_unit')]);
  });

  it('10. an action deliversMessage false is no finding', () => {
    const policy: ConfirmationPolicy = { actions: { delete_unit: { ...actions.delete_unit, deliversMessage: false } } };
    expect(checkConfirmationPolicy({ policy, registry })).toEqual([]);
  });
});

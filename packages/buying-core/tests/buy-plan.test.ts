import { describe, it, expect } from 'vitest';
import { buildBuyPlan, simulateBuy, summariseConsolidation, type BuyPlanRowInput } from '../src/buy-plan';
import type { SupplierScore } from '../src/po-scoring';

const planRow = (
  sku: string,
  o: {
    brand?: string;
    risk?: 'STOCKOUT' | 'High' | 'Medium' | 'Low';
    buy?: number;
    cost?: number | null;
    reorder?: boolean;
    label?: string | null;
    isActive?: boolean;
    hasAdSpend?: boolean;
    /** EOQ base before top-up (defaults to buy = no raise). */
    eoqBase?: number;
    eoqApplied?: boolean;
    eoqAnnualDemand?: number;
    /** Post-EOQ figure (before min/pack); defaults to buy = no EOQ raise. */
    eoqQty?: number;
    /** Post-min, pre-pack figure; defaults to eoqQty/prePack/buy. */
    prePack?: number;
    minQty?: number | null;
    minApplied?: boolean;
    packQty?: number | null;
    packApplied?: boolean;
  } = {},
): BuyPlanRowInput => ({
  sku,
  name: `${sku} name`,
  ...(o.isActive === undefined ? {} : { is_active: o.isActive }),
  brand: o.brand ?? 'Brand F',
  stats: { unit_cost: o.cost === undefined ? 10 : o.cost, rrp: 30, qty: 0, class_1: 'CAT_A' },
  derived: {
    stockout_risk: o.risk ?? 'High',
    reorder: o.reorder ?? true,
    suggested_buy_qty: o.buy ?? 10,
    coverage_days: 5,
    forward_coverage_days: null,
    basis: 'trailing',
    coverage_target_days: 30,
    lead_time_days: 14,
    incoming_next_2m: 0,
    eoq_base_qty: o.eoqBase ?? o.eoqQty ?? o.prePack ?? o.buy ?? 10,
    eoq_qty: o.eoqQty ?? o.prePack ?? o.buy ?? 10,
    eoq_applied: o.eoqApplied ?? false,
    eoq_annual_demand: o.eoqAnnualDemand ?? 0,
    min_order_qty: o.minQty ?? null,
    min_applied: o.minApplied ?? false,
    pack_qty: o.packQty ?? null,
    pack_applied: o.packApplied ?? false,
    pre_pack_qty: o.prePack ?? o.eoqQty ?? o.buy ?? 10,
  },
  reasons: [],
  label: o.label ?? null,
  has_ad_spend: o.hasAdSpend ?? false,
});

const supplier = (name: string): SupplierScore => ({
  supplier: name,
  po_count: 1,
  units_total: 10,
  units_received: 10,
  units_sold: 8,
  total_cost: 100,
  margin: 50,
  sell_through_pct: 80,
  avg_margin_per_landed_cost: 0.5,
  dead_stock_units: 0,
  otif_pct: 100,
  avg_slip_days: 0,
  lead_time_p50_days: 45,
  lead_time_p90_days: 60,
  last_po_date: '2026-06-01',
  tier: 'Preferred',
});

describe('buildBuyPlan', () => {
  it('orders most-urgent first and trims to brand budget headroom with visible skips', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-2', { risk: 'High', buy: 20, cost: 10 }), // 200, second priority
        planRow('SKU-1', { risk: 'STOCKOUT', buy: 10, cost: 10 }), // 100, first
        planRow('SKU-3', { brand: 'Brand L', risk: 'High', buy: 5, cost: 20 }), // no budget: unconstrained
      ],
      brandBudgets: { 'BRAND F': 1150 }, // stock value 1000: headroom 150
      brandStockValue: { 'Brand F': 1000, 'Brand L': 500 },
      supplierBySku: new Map([['SKU-1', supplier('Supplier 1')]]),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    expect(plan.lines.map((l) => `${l.sku}:${l.action}`)).toEqual([
      'SKU-1:order', // 100 fits the 150 headroom
      'SKU-2:skip', // 200 does not fit the remaining 50
      'SKU-3:order', // brand without a budget passes through
    ]);
    const skipped = plan.lines[1]!;
    expect(skipped.reasons.some((r) => r.code === 'OTB_EXHAUSTED')).toBe(true);
    expect(plan.lines[0]!.supplier?.lead_time_p50_days).toBe(45);
    expect(plan.totals).toMatchObject({ order_count: 2, order_cost_total: 200, skipped_for_budget: 1, within_budget: false });
    const fff = plan.budgets.find((b) => b.brand === 'Brand F')!;
    expect(fff).toMatchObject({ headroom_before: 150, committed: 100, headroom_after: 50 });
  });

  it('lifts a stocked-out row whose label maps to priority above ordinary stockouts, with a PRIORITY_STOCKOUT reason naming the label', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-1', { risk: 'STOCKOUT', buy: 5, cost: 10 }), // ordinary stockout
        planRow('SKU-2', { risk: 'STOCKOUT', buy: 5, cost: 10, label: 'LABEL_TOP' }), // priority
        planRow('SKU-3', { risk: 'High', buy: 5, cost: 10 }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
      label_roles: { LABEL_TOP: 'priority' },
    });
    // The priority row sorts to the very top even though both are STOCKOUT tier.
    expect(plan.lines.map((l) => l.sku)).toEqual(['SKU-2', 'SKU-1', 'SKU-3']);
    expect(plan.lines[0]!.is_priority).toBe(true);
    expect(plan.lines[0]!.reasons[0]).toEqual({
      code: 'PRIORITY_STOCKOUT',
      detail: 'stocked out, labelled priority (LABEL_TOP) - buy first',
    });
    // An unlabelled stockout is not marked priority.
    expect(plan.lines.find((l) => l.sku === 'SKU-1')!.is_priority).toBe(false);
  });

  it('prioritises nothing without label_roles: labelled rows keep the risk-then-quantity order', () => {
    const args = {
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map<string, SupplierScore>(),
      budget_aware: false,
      handling_cost_per_line: 4,
    };
    const rows = (label: string | null) => [
      planRow('SKU-1', { risk: 'STOCKOUT', buy: 9, cost: 10 }),
      planRow('SKU-2', { risk: 'STOCKOUT', buy: 5, cost: 10, label }),
      planRow('SKU-3', { risk: 'High', buy: 5, cost: 10 }),
    ];
    const unlabelled = buildBuyPlan({ ...args, rows: rows(null) });
    const labelled = buildBuyPlan({ ...args, rows: rows('LABEL_TOP') });
    for (const plan of [unlabelled, labelled]) {
      expect(plan.lines.map((l) => l.sku)).toEqual(['SKU-1', 'SKU-2', 'SKU-3']);
      expect(plan.lines.map((l) => l.is_priority)).toEqual([false, false, false]);
      expect(plan.lines.flatMap((l) => l.reasons)).toEqual([]);
    }
    // The label is still carried on the line; it just drives nothing.
    expect(labelled.lines[1]!.label).toBe('LABEL_TOP');
  });

  it('prioritises only the priority role: a run_down or unmapped label does not lead the plan', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-1', { risk: 'STOCKOUT', buy: 9, cost: 10 }),
        planRow('SKU-2', { risk: 'STOCKOUT', buy: 5, cost: 10, label: 'LABEL_RUNDOWN' }),
        planRow('SKU-3', { risk: 'STOCKOUT', buy: 3, cost: 10, label: 'LABEL_OTHER' }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
      label_roles: { LABEL_TOP: 'priority', LABEL_RUNDOWN: 'run_down' },
    });
    expect(plan.lines.map((l) => l.sku)).toEqual(['SKU-1', 'SKU-2', 'SKU-3']);
    expect(plan.lines.some((l) => l.is_priority)).toBe(false);
  });

  it('tags a stocked-out SKU still spending on ads with an AD_WASTE reason', () => {
    const plan = buildBuyPlan({
      rows: [planRow('SKU-1', { risk: 'STOCKOUT', buy: 5, cost: 10, hasAdSpend: true })],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    expect(plan.lines[0]!.reasons.some((r) => r.code === 'AD_WASTE')).toBe(true);
  });

  it('does not mark a priority-labelled row that is NOT stocked out', () => {
    const plan = buildBuyPlan({
      rows: [planRow('SKU-1', { risk: 'High', buy: 5, cost: 10, label: 'LABEL_TOP' })],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
      label_roles: { LABEL_TOP: 'priority' },
    });
    expect(plan.lines[0]!.is_priority).toBe(false);
    expect(plan.lines[0]!.reasons.some((r) => r.code === 'PRIORITY_STOCKOUT')).toBe(false);
  });

  it('leaves a row with no brand unconstrained: it matches no brand budget', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-1', { brand: '', buy: 10, cost: 10 }), // 100, no brand
        planRow('SKU-2', { brand: 'Brand F', buy: 5, cost: 10 }), // 50, over its 10 headroom
      ],
      // An entry stored under an empty key must not be read as the no-brand budget.
      brandBudgets: { '': 1, 'BRAND F': 10 },
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    const actions = Object.fromEntries(plan.lines.map((l) => [l.sku, l.action]));
    expect(actions).toEqual({ 'SKU-1': 'order', 'SKU-2': 'skip' });
    expect(plan.budgets.find((b) => b.brand === '')).toMatchObject({
      budget: null,
      headroom_before: null,
      committed: 100,
      headroom_after: null,
    });
    expect(plan.totals).toMatchObject({ order_count: 1, order_cost_total: 100, skipped_for_budget: 1 });
  });

  it('drops a row marked is_active false and keeps one that does not say', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-1', { buy: 5 }), // is_active absent: active
        planRow('SKU-2', { buy: 5, isActive: false }),
        planRow('SKU-3', { buy: 5, isActive: true }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    expect(plan.lines.map((l) => l.sku)).toEqual(['SKU-1', 'SKU-3']);
  });

  it('marks inbound-covered stockouts expedite and uncosted lines review', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('SKU-1', { risk: 'STOCKOUT', buy: 0 }),
        planRow('SKU-2', { buy: 5, cost: null }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    const actions = Object.fromEntries(plan.lines.map((l) => [l.sku, l.action]));
    expect(actions['SKU-1']).toBe('expedite');
    expect(actions['SKU-2']).toBe('review');
    expect(plan.lines.find((l) => l.sku === 'SKU-2')!.reasons.some((r) => r.code === 'UNCOSTED')).toBe(true);
    expect(plan.totals.uncosted_lines).toBe(1);
  });
});

describe('buildBuyPlan consolidation summary', () => {
  it('folds the EOQ raises into a plan-wide consolidation summary (only ordered lines)', () => {
    const plan = buildBuyPlan({
      rows: [
        // Raised 1 -> 15, D=60/yr, unit cost 8. Ordered.
        planRow('SKU-1', {
          risk: 'High',
          buy: 15,
          cost: 8,
          eoqBase: 1,
          eoqApplied: true,
          eoqAnnualDemand: 60,
        }),
        // Not raised (base == qty): contributes nothing.
        planRow('SKU-2', { risk: 'High', buy: 5, cost: 10, eoqBase: 5, eoqApplied: false, eoqAnnualDemand: 100 }),
        // Raised 2 -> 8, D=48/yr, unit cost 12. Skipped for budget on Brand U: excluded from summary.
        planRow('SKU-3', {
          brand: 'Brand U',
          risk: 'High',
          buy: 8,
          cost: 12,
          eoqBase: 2,
          eoqApplied: true,
          eoqAnnualDemand: 48,
        }),
      ],
      brandBudgets: { 'BRAND U': 500 }, // stock value 500 -> headroom 0, so SKU-3 skips
      brandStockValue: { 'Brand U': 500 },
      supplierBySku: new Map(),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    const c = plan.totals.consolidation;
    // Only SKU-1 was ordered AND raised.
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(14); // 15 - 1
    expect(c.extra_unit_cost).toBe(112); // 14 * 8
    // trips_before = 60/1 = 60; trips_after = 60/15 = 4; avoided = 56.
    expect(c.trips_avoided_per_year).toBe(56);
    expect(c.labour_saving_per_year).toBe(224); // 56 * 4
    expect(c.handling_cost_per_line).toBe(4);
    expect(c.methodology).toMatch(/economic order quantity/i);
  });

  it('claims no labour saving when no handling cost is supplied, and still counts the raise', () => {
    const plan = buildBuyPlan({
      rows: [planRow('SKU-1', { risk: 'High', buy: 15, cost: 8, eoqBase: 1, eoqApplied: true, eoqAnnualDemand: 60 })],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
    });
    expect(plan.totals.consolidation).toMatchObject({
      lines_raised: 1,
      extra_units: 14,
      trips_avoided_per_year: 56,
      labour_saving_per_year: 0,
      handling_cost_per_line: 0,
    });
  });

  it('summariseConsolidation is zero when nothing was raised', () => {
    const c = summariseConsolidation(
      [
        { eoq_applied: false, eoq_base_qty: 5, eoq_qty: 5, eoq_annual_demand: 100, unit_cost: 10 },
        { eoq_applied: true, eoq_base_qty: 4, eoq_qty: 4, eoq_annual_demand: 50, unit_cost: 10 }, // applied but qty==base
      ],
      4,
    );
    expect(c.lines_raised).toBe(0);
    expect(c.extra_units).toBe(0);
    expect(c.trips_avoided_per_year).toBe(0);
    expect(c.labour_saving_per_year).toBe(0);
  });

  it('summariseConsolidation skips the cost term for an uncosted raised line but still counts trips', () => {
    const c = summariseConsolidation(
      [{ eoq_applied: true, eoq_base_qty: 1, eoq_qty: 10, eoq_annual_demand: 100, unit_cost: null }],
      5,
    );
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(9);
    expect(c.extra_unit_cost).toBe(0); // no unit cost, no cost figure
    // trips_before = 100/1 = 100; trips_after = 100/10 = 10; avoided = 90.
    expect(c.trips_avoided_per_year).toBe(90);
    expect(c.labour_saving_per_year).toBe(450); // 90 * 5
  });
});

describe('buildBuyPlan pack-rounding consolidation split', () => {
  it('counts pack roundings separately from EOQ raises, with the EOQ trips math on pre-pack figures', () => {
    const plan = buildBuyPlan({
      rows: [
        // EOQ raised 1 -> 15, THEN a pack of 10 rounded 15 -> 20. Unit cost 8, D=60/yr.
        planRow('SKU-1', {
          risk: 'High',
          buy: 20,
          cost: 8,
          eoqBase: 1,
          eoqApplied: true,
          eoqAnnualDemand: 60,
          prePack: 15,
          packQty: 10,
          packApplied: true,
        }),
        // Pack-only: no EOQ raise, base 7 rounded to one pack of 10. Unit cost 10.
        planRow('SKU-2', {
          risk: 'High',
          buy: 10,
          cost: 10,
          eoqBase: 7,
          eoqApplied: false,
          prePack: 7,
          packQty: 10,
          packApplied: true,
        }),
        // Neither raised nor packed: contributes nothing.
        planRow('SKU-3', { risk: 'High', buy: 5, cost: 10 }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    const c = plan.totals.consolidation;
    // EOQ side: only SKU-1, measured base -> PRE-pack figure (1 -> 15).
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(14);
    expect(c.extra_unit_cost).toBe(112); // 14 x 8
    // trips_before = 60/1 = 60; trips_after uses the PRE-pack 15 (60/15 = 4),
    // so pack rounding never inflates the EOQ labour claim.
    expect(c.trips_avoided_per_year).toBe(56);
    expect(c.labour_saving_per_year).toBe(224);
    // Pack side: SKU-1 adds 5 units (cost 40), SKU-2 adds 3 units (cost 30).
    expect(c.packs_applied).toBe(2);
    expect(c.pack_extra_units).toBe(8);
    expect(c.pack_extra_unit_cost).toBe(70);
    // The line surface carries the pack fields, and costs use the FINAL qty.
    const both = plan.lines.find((l) => l.sku === 'SKU-1')!;
    expect(both).toMatchObject({ suggested_qty: 20, pre_pack_qty: 15, pack_qty: 10, pack_applied: true });
    expect(both.order_cost).toBe(160); // 20 x 8 - budget/costs consume the packed qty
    expect(c.methodology).toMatch(/pack/i);
  });

  it('counts min lifts separately from EOQ raises and pack roundings', () => {
    // Row 1 - EOQ 4 (base 4, no raise), min 10 lifts to 10, no pack. Unit cost 10.
    // Row 2 - EOQ raised 1 -> 8, min 10 lifts 8 -> 10, pack 4 rounds 10 -> 12. Unit cost 5.
    const c = summariseConsolidation(
      [
        {
          eoq_applied: false,
          eoq_base_qty: 4,
          eoq_qty: 4,
          eoq_annual_demand: 0,
          unit_cost: 10,
          pre_pack_qty: 10, // post-min
          min_applied: true,
          final_qty: 10,
          pack_applied: false,
        },
        {
          eoq_applied: true,
          eoq_base_qty: 1,
          eoq_qty: 8,
          eoq_annual_demand: 40,
          unit_cost: 5,
          pre_pack_qty: 10, // post-min (8 -> 10)
          min_applied: true,
          final_qty: 12, // post-pack (10 -> 12)
          pack_applied: true,
        },
      ],
      4,
    );
    // EOQ side: only row 2 (1 -> 8).
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(7);
    // Min side: row 1 adds 6 (cost 60), row 2 adds 2 (cost 10) -> 8 units, cost 70.
    expect(c.mins_applied).toBe(2);
    expect(c.min_extra_units).toBe(8);
    expect(c.min_extra_unit_cost).toBe(70);
    // Pack side: only row 2 (10 -> 12) adds 2 units (cost 10).
    expect(c.packs_applied).toBe(1);
    expect(c.pack_extra_units).toBe(2);
    expect(c.pack_extra_unit_cost).toBe(10);
    expect(c.methodology).toMatch(/minimum/i);
  });
});

describe('simulateBuy', () => {
  it('re-derives risk per line, totals the cash, and names unknown SKUs', () => {
    const bySku = new Map([
      [
        'SKU-1',
        {
          stats: { unit_cost: 10, qty: 0 },
          derived: {
            stockout_risk: 'STOCKOUT' as const,
            coverage_days: 0,
            forward_coverage_days: null,
            basis: 'trailing' as const,
          },
          withExtraUnits: (extra: number) => ({
            stockout_risk: extra >= 20 ? 'Low' : 'High',
            coverage_days: extra,
            forward_coverage_days: null,
          }),
        },
      ],
    ]);
    const sim = simulateBuy({ lines: [{ sku: 'SKU-1', qty: 30 }, { sku: 'SKU-9', qty: 1 }], bySku });
    expect(sim.unknown_skus).toEqual(['SKU-9']);
    expect(sim.lines[0]).toMatchObject({ sku: 'SKU-1', risk_before: 'STOCKOUT', risk_after: 'Low', order_cost: 300 });
    expect(sim.totals.order_cost_total).toBe(300);
  });
});

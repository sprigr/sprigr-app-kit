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
  status: 'active',
  brand: o.brand ?? 'FFF',
  stats: { unit_cost: o.cost === undefined ? 10 : o.cost, rrp: 30, qty: 0, class_1: 'Accessories' },
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
  avg_gmroi: 0.5,
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
        planRow('FFF:B', { risk: 'High', buy: 20, cost: 10 }), // $200, second priority
        planRow('FFF:A', { risk: 'STOCKOUT', buy: 10, cost: 10 }), // $100, first
        planRow('LLL:C', { brand: 'LLL', risk: 'High', buy: 5, cost: 20 }), // no budget → unconstrained
      ],
      brandBudgets: { FFF: 1150 }, // stock value 1000 → headroom 150
      brandStockValue: { FFF: 1000, LLL: 500 },
      supplierBySku: new Map([['FFF:A', supplier('Brand F Supply')]]),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    expect(plan.lines.map((l) => `${l.sku}:${l.action}`)).toEqual([
      'FFF:A:order', // $100 fits the $150 headroom
      'FFF:B:skip', // $200 does not fit the remaining $50
      'LLL:C:order', // brand without a budget passes through
    ]);
    const skipped = plan.lines[1]!;
    expect(skipped.reasons.some((r) => r.code === 'OTB_EXHAUSTED')).toBe(true);
    expect(plan.lines[0]!.supplier?.lead_time_p50_days).toBe(45);
    expect(plan.totals).toMatchObject({ order_count: 2, order_cost_total: 200, skipped_for_budget: 1, within_budget: false });
    const fff = plan.budgets.find((b) => b.brand === 'FFF')!;
    expect(fff).toMatchObject({ headroom_before: 150, committed: 100, headroom_after: 50 });
  });

  it('lifts a STOCKED-OUT Hero above ordinary stockouts with a HERO_SKU reason', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('ORD:1', { risk: 'STOCKOUT', buy: 5, cost: 10 }), // ordinary stockout
        planRow('HERO:1', { risk: 'STOCKOUT', buy: 5, cost: 10, label: 'Heroes' }), // hero
        planRow('HI:1', { risk: 'High', buy: 5, cost: 10 }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    // Hero sorts to the very top even though both are STOCKOUT tier.
    expect(plan.lines[0]!.sku).toBe('HERO:1');
    expect(plan.lines[0]!.is_hero).toBe(true);
    expect(plan.lines[0]!.reasons[0]!.code).toBe('HERO_SKU');
    // A non-hero stockout is not marked hero.
    expect(plan.lines.find((l) => l.sku === 'ORD:1')!.is_hero).toBe(false);
  });

  it('tags a stocked-out SKU still spending on ads with an AD_WASTE reason', () => {
    const plan = buildBuyPlan({
      rows: [planRow('WASTE:1', { risk: 'STOCKOUT', buy: 5, cost: 10, hasAdSpend: true })],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    expect(plan.lines[0]!.reasons.some((r) => r.code === 'AD_WASTE')).toBe(true);
  });

  it('does not mark a Hero that is NOT stocked out (only stocked-out Heroes lead)', () => {
    const plan = buildBuyPlan({
      rows: [planRow('HERO:2', { risk: 'High', buy: 5, cost: 10, label: 'Heroes' })],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    expect(plan.lines[0]!.is_hero).toBe(false);
    expect(plan.lines[0]!.reasons.some((r) => r.code === 'HERO_SKU')).toBe(false);
  });

  it('marks inbound-covered stockouts expedite and uncosted lines review', () => {
    const plan = buildBuyPlan({
      rows: [
        planRow('EXP:1', { risk: 'STOCKOUT', buy: 0 }),
        planRow('UNC:1', { buy: 5, cost: null }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    const actions = Object.fromEntries(plan.lines.map((l) => [l.sku, l.action]));
    expect(actions['EXP:1']).toBe('expedite');
    expect(actions['UNC:1']).toBe('review');
    expect(plan.lines.find((l) => l.sku === 'UNC:1')!.reasons.some((r) => r.code === 'UNCOSTED')).toBe(true);
    expect(plan.totals.uncosted_lines).toBe(1);
  });
});

describe('buildBuyPlan consolidation summary', () => {
  it('folds the EOQ raises into a plan-wide consolidation summary (only ordered lines)', () => {
    const plan = buildBuyPlan({
      rows: [
        // Raised 1 -> 15, D=60/yr, $8. Ordered.
        planRow('ACC:1', {
          risk: 'High',
          buy: 15,
          cost: 8,
          eoqBase: 1,
          eoqApplied: true,
          eoqAnnualDemand: 60,
        }),
        // Not raised (base == qty): contributes nothing.
        planRow('ACC:2', { risk: 'High', buy: 5, cost: 10, eoqBase: 5, eoqApplied: false, eoqAnnualDemand: 100 }),
        // Raised 2 -> 8, D=48/yr, $12. Skipped for budget on brand BUD: excluded from summary.
        planRow('BUD:1', {
          brand: 'BUD',
          risk: 'High',
          buy: 8,
          cost: 12,
          eoqBase: 2,
          eoqApplied: true,
          eoqAnnualDemand: 48,
        }),
      ],
      brandBudgets: { BUD: 500 }, // stock value 500 -> headroom 0, so BUD:1 skips
      brandStockValue: { BUD: 500 },
      supplierBySku: new Map(),
      budget_aware: true,
      handling_cost_per_line: 4,
    });
    const c = plan.totals.consolidation;
    // Only ACC:1 was ordered AND raised.
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(14); // 15 - 1
    expect(c.extra_unit_cost).toBe(112); // 14 * $8
    // trips_before = 60/1 = 60; trips_after = 60/15 = 4; avoided = 56.
    expect(c.trips_avoided_per_year).toBe(56);
    expect(c.labour_saving_per_year).toBe(224); // 56 * $4
    expect(c.handling_cost_per_line).toBe(4);
    expect(c.methodology).toMatch(/economic order quantity/i);
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
    expect(c.extra_unit_cost).toBe(0); // no unit cost, no dollar figure
    // trips_before = 100/1 = 100; trips_after = 100/10 = 10; avoided = 90.
    expect(c.trips_avoided_per_year).toBe(90);
    expect(c.labour_saving_per_year).toBe(450); // 90 * $5
  });
});

describe('buildBuyPlan pack-rounding consolidation split', () => {
  it('counts pack roundings separately from EOQ raises, with the EOQ trips math on pre-pack figures', () => {
    const plan = buildBuyPlan({
      rows: [
        // EOQ raised 1 -> 15, THEN a pack of 10 rounded 15 -> 20. $8, D=60/yr.
        planRow('BOTH:1', {
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
        // Pack-only: no EOQ raise, base 7 rounded to one pack of 10. $10.
        planRow('PACK:1', {
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
        planRow('PLAIN:1', { risk: 'High', buy: 5, cost: 10 }),
      ],
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: 4,
    });
    const c = plan.totals.consolidation;
    // EOQ side: only BOTH:1, measured base -> PRE-pack figure (1 -> 15).
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(14);
    expect(c.extra_unit_cost).toBe(112); // 14 x $8
    // trips_before = 60/1 = 60; trips_after uses the PRE-pack 15 (60/15 = 4),
    // so pack rounding never inflates the EOQ labour claim.
    expect(c.trips_avoided_per_year).toBe(56);
    expect(c.labour_saving_per_year).toBe(224);
    // Pack side: BOTH:1 adds 5 units ($40), PACK:1 adds 3 units ($30).
    expect(c.packs_applied).toBe(2);
    expect(c.pack_extra_units).toBe(8);
    expect(c.pack_extra_unit_cost).toBe(70);
    // The line surface carries the pack fields, and costs use the FINAL qty.
    const both = plan.lines.find((l) => l.sku === 'BOTH:1')!;
    expect(both).toMatchObject({ suggested_qty: 20, pre_pack_qty: 15, pack_qty: 10, pack_applied: true });
    expect(both.order_cost).toBe(160); // 20 x $8 - budget/costs consume the packed qty
    expect(c.methodology).toMatch(/pack/i);
  });

  it('counts min lifts separately from EOQ raises and pack roundings', () => {
    // MIN:1 - EOQ 4 (base 4, no raise), min 10 lifts to 10, no pack. $10.
    // BOTH:2 - EOQ raised 1 -> 8, min 10 lifts 8 -> 10, pack 4 rounds 10 -> 12. $5.
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
    // EOQ side: only BOTH:2 (1 -> 8).
    expect(c.lines_raised).toBe(1);
    expect(c.extra_units).toBe(7);
    // Min side: MIN:1 adds 6 ($60), BOTH:2 adds 2 ($10) -> 8 units, $70.
    expect(c.mins_applied).toBe(2);
    expect(c.min_extra_units).toBe(8);
    expect(c.min_extra_unit_cost).toBe(70);
    // Pack side: only BOTH:2 (10 -> 12) adds 2 units ($10).
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
        'FFF:A',
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
    const sim = simulateBuy({ lines: [{ sku: 'FFF:A', qty: 30 }, { sku: 'NOPE', qty: 1 }], bySku });
    expect(sim.unknown_skus).toEqual(['NOPE']);
    expect(sim.lines[0]).toMatchObject({ sku: 'FFF:A', risk_before: 'STOCKOUT', risk_after: 'Low', order_cost: 300 });
    expect(sim.totals.order_cost_total).toBe(300);
  });
});

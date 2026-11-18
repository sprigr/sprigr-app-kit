import { describe, it, expect } from 'vitest';
import { computeOtb, monthPlus } from '../src/otb';

describe('monthPlus', () => {
  it('rolls across year boundaries', () => {
    expect(monthPlus('2026-07', 0)).toBe('2026-07');
    expect(monthPlus('2026-11', 3)).toBe('2027-02');
  });
});

describe('computeOtb', () => {
  it('applies the canonical formula and chains BOM from planned EOM', () => {
    const [res] = computeOtb({
      currentMonth: '2026-07',
      horizonMonths: 2,
      plans: [
        { month: '2026-07', key: 'Brand F', planned_sales: 1000, planned_markdowns: 200, planned_eom: 5000 },
        { month: '2026-08', key: 'Brand F', planned_sales: 800, planned_markdowns: 100, planned_eom: 4500 },
      ],
      stockValue: { 'Brand F': 6000 }, // actual BOM for month 0
      onOrderByMonth: { 'Brand F': { '2026-07': 500 } },
    });
    expect(res!.key).toBe('Brand F');
    // Month 0: 1000 + 200 + 5000 - 6000 (actual BOM) - 500 (on order) = -300 (overbought).
    expect(res!.months[0]!.otb).toBe(-300);
    expect(res!.months[0]!.bom).toBe(6000);
    // Month 1: BOM chains from month 0 planned EOM (5000).
    // 800 + 100 + 4500 - 5000 - 0 = 400.
    expect(res!.months[1]!.bom).toBe(5000);
    expect(res!.months[1]!.otb).toBe(400);
    expect(res!.otb_now).toBe(-300);
    expect(res!.otb_horizon).toBe(100);
  });

  it('counts pre-horizon ETAs against the first month and surfaces unplanned keys', () => {
    const results = computeOtb({
      currentMonth: '2026-07',
      horizonMonths: 1,
      plans: [], // no plan at all
      stockValue: { 'Brand L': 2000 },
      onOrderByMonth: { 'Brand L': { '2026-05': 300, '2026-07': 100 } }, // May ETA is overdue
    });
    const lll = results.find((r) => r.key === 'Brand L')!;
    expect(lll.months[0]!.on_order).toBe(400); // 300 early + 100 this month
    // No plan → OTB = 0 + 0 + 0 - 2000 - 400 = -2400 (sell it down before buying).
    expect(lll.otb_now).toBe(-2400);
  });
});

describe('computeOtb gap months', () => {
  it('carries BOM forward through a leading unplanned month instead of collapsing it to 0', () => {
    const [res] = computeOtb({
      currentMonth: '2026-10',
      horizonMonths: 2,
      plans: [{ month: '2026-11', key: 'Brand G', planned_sales: 10000, planned_markdowns: 0, planned_eom: 40000 }],
      stockValue: { 'Brand G': 50000 },
      onOrderByMonth: {},
    });
    expect(res!.key).toBe('Brand G');
    // Month 0 (2026-10): no plan, muted; BOM is the actual stock value.
    expect(res!.months[0]!.bom).toBe(50000);
    expect(res!.months[0]!.otb).toBe(-50000);
    // Month 1 (2026-11): BOM carries forward from month 0 (no EOM to chain
    // from in the unplanned gap), not collapsed to 0.
    expect(res!.months[1]!.bom).toBe(50000);
    // 10000 + 0 + 40000 - 50000 - 0 = 0 (stock carried in covers the plan).
    expect(res!.months[1]!.otb).toBe(0);
  });

  it('carries BOM/OTB correctly through a gap in the middle of a planned run', () => {
    const [res] = computeOtb({
      currentMonth: '2026-10',
      horizonMonths: 3,
      plans: [
        { month: '2026-10', key: 'Brand M', planned_sales: 1000, planned_markdowns: 0, planned_eom: 20000 },
        // 2026-11 has no plan row (the gap).
        { month: '2026-12', key: 'Brand M', planned_sales: 5000, planned_markdowns: 0, planned_eom: 15000 },
      ],
      stockValue: { 'Brand M': 25000 },
      onOrderByMonth: {},
    });
    expect(res!.key).toBe('Brand M');
    // Month 0 (2026-10): planned, actual stock as BOM.
    expect(res!.months[0]!.bom).toBe(25000);
    expect(res!.months[0]!.otb).toBe(1000 + 0 + 20000 - 25000 - 0);
    // Month 1 (2026-11): unplanned gap, BOM chains from month 0's planned EOM (20000).
    expect(res!.months[1]!.bom).toBe(20000);
    expect(res!.months[1]!.otb).toBe(0 + 0 + 0 - 20000 - 0);
    // Month 2 (2026-12): planned again; BOM carries forward unchanged through
    // the gap (still 20000, not collapsed to 0 by the unplanned month).
    expect(res!.months[2]!.bom).toBe(20000);
    expect(res!.months[2]!.otb).toBe(5000 + 0 + 15000 - 20000 - 0);
  });
});

describe('computeOtb planned flags', () => {
  it('marks planned vs unplanned months and has_plan per key', () => {
    const [fff] = computeOtb({
      currentMonth: '2026-07',
      horizonMonths: 2,
      plans: [{ month: '2026-07', key: 'Brand F', planned_sales: 1000, planned_markdowns: 0, planned_eom: 0 }],
      stockValue: { 'Brand F': 500 },
      onOrderByMonth: {},
    });
    expect(fff!.months[0]!.planned).toBe(true);
    expect(fff!.months[1]!.planned).toBe(false);
    expect(fff!.has_plan).toBe(true);

    const noPlan = computeOtb({ currentMonth: '2026-07', horizonMonths: 1, plans: [], stockValue: { 'Brand L': 200 }, onOrderByMonth: {} })[0]!;
    expect(noPlan.has_plan).toBe(false);
    expect(noPlan.months[0]!.planned).toBe(false);
  });
});

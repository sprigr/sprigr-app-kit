/**
 * buying-core - open-to-buy (pure).
 *
 * The canonical six-month-plan formula per (dimension, key, month):
 *
 *   OTB_m = planned_sales_m + planned_markdowns_m + planned_EOM_m
 *           - BOM_m - on_order_m
 *
 * BOM of the FIRST month in the horizon is the actual current stock value;
 * each later month's BOM chains from the prior month's planned EOM (the plan
 * assumes you trade to plan). on_order is the landed value of incoming PO
 * units bucketed by ETA month; ETAs before the horizon count against the
 * first month (they land before it opens). All money figures are COST value
 * in store currency, matching the stock-value budgets. No I/O: the caller
 * supplies plans + actuals.
 */

export interface OtbPlanRow {
  month: string; // YYYY-MM
  key: string;
  planned_sales: number;
  planned_markdowns: number;
  planned_eom: number;
}

export interface OtbMonth {
  month: string;
  planned_sales: number;
  planned_markdowns: number;
  planned_eom: number;
  /** Beginning-of-month stock value: actual for the first month, chained planned EOM after. */
  bom: number;
  /** Landed value of incoming POs with an ETA inside this month. */
  on_order: number;
  /** The formula result. Positive = store currency available to spend into this month. */
  otb: number;
  /** True when a plan is entered for this cell (any of sales/markdowns/EOM > 0).
   * When false, otb is just the negative stock/on-order position, so a caller
   * can show it muted rather than as an "overbought" warning. */
  planned: boolean;
}

export interface OtbKeyResult {
  key: string;
  months: OtbMonth[];
  /** OTB of the CURRENT (first) month - the "can I spend today" number. */
  otb_now: number;
  /** Total OTB across the horizon (can be negative = overbought vs plan). */
  otb_horizon: number;
  /** True when this key has a plan in any month of the horizon. */
  has_plan: boolean;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** YYYY-MM + n months. */
export function monthPlus(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Compute OTB for one dimension. horizonMonths months starting at
 * currentMonth; a key appears when it has a plan row in the horizon OR
 * current stock/on-order (so an unplanned key still shows its position with
 * OTB driven by zero plans - reading "sell it down before buying more").
 */
export function computeOtb(args: {
  currentMonth: string;
  horizonMonths: number;
  plans: OtbPlanRow[];
  /** Actual current stock value per key (cost). */
  stockValue: Record<string, number>;
  /** Incoming landed value per key per ETA month (YYYY-MM). */
  onOrderByMonth: Record<string, Record<string, number>>;
}): OtbKeyResult[] {
  const months = Array.from({ length: Math.max(1, args.horizonMonths) }, (_, i) =>
    monthPlus(args.currentMonth, i),
  );
  const firstMonth = months[0]!;

  const keys = new Set<string>();
  for (const p of args.plans) if (months.includes(p.month)) keys.add(p.key);
  for (const k of Object.keys(args.stockValue)) if (args.stockValue[k]! > 0) keys.add(k);
  for (const k of Object.keys(args.onOrderByMonth)) keys.add(k);

  const planByKeyMonth = new Map<string, OtbPlanRow>();
  for (const p of args.plans) planByKeyMonth.set(`${p.key}|${p.month}`, p);

  const out: OtbKeyResult[] = [];
  for (const key of [...keys].sort()) {
    const rows: OtbMonth[] = [];
    let bom = args.stockValue[key] ?? 0;
    const etas = args.onOrderByMonth[key] ?? {};
    // ETAs before the horizon land before it opens: count them in month 0.
    let earlyOnOrder = 0;
    for (const [etaMonth, value] of Object.entries(etas)) {
      if (etaMonth < firstMonth) earlyOnOrder += value;
    }
    for (const month of months) {
      const plan = planByKeyMonth.get(`${key}|${month}`);
      const plannedSales = plan?.planned_sales ?? 0;
      const plannedMd = plan?.planned_markdowns ?? 0;
      const plannedEom = plan?.planned_eom ?? 0;
      const onOrder = (etas[month] ?? 0) + (month === firstMonth ? earlyOnOrder : 0);
      const otb = plannedSales + plannedMd + plannedEom - bom - onOrder;
      rows.push({
        month,
        planned_sales: r2(plannedSales),
        planned_markdowns: r2(plannedMd),
        planned_eom: r2(plannedEom),
        bom: r2(bom),
        on_order: r2(onOrder),
        otb: r2(otb),
        planned: plannedSales > 0 || plannedMd > 0 || plannedEom > 0,
      });
      // chain: next month's BOM is this month's planned EOM, but an unplanned
      // month has no EOM to chain from - carry the current BOM forward
      // instead of collapsing it to 0 and losing the stock mid-chain.
      if (plan) bom = plannedEom;
    }
    out.push({
      key,
      months: rows,
      otb_now: rows[0]!.otb,
      otb_horizon: r2(rows.reduce((s, r) => s + r.otb, 0)),
      has_plan: rows.some((r) => r.planned),
    });
  }
  return out;
}

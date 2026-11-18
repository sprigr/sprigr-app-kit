/**
 * buying-core - the buy plan + what-if simulation (pure).
 *
 * buildBuyPlan turns derived SKU rows into ONE decision surface: every
 * line that wants ordering, priced, reasoned, and (optionally) trimmed to the
 * stock-value budget headroom per brand. simulateBuy answers "what happens if
 * I buy these quantities" without side effects. Both are pure: pass them the
 * same derived rows the reorder queue uses, so plan numbers can never
 * disagree with queue numbers.
 *
 * Budget model: headroom = stock-value budget
 * minus current stock value per brand; each ordered line consumes headroom at
 * its order cost. Lines whose brand has no budget pass through unconstrained
 * (otb.budget null). This is a proxy for open-to-buy, named accordingly in
 * the payload so the semantics are honest.
 */

import { resolveLabelRole, type DerivedSkuMetrics, type LabelRole, type SkuStats } from './buyer-metrics';
import type { Reason } from './reason-codes';
import { reason } from './reason-codes';
import { brandLookup } from './brand-key';
import type { SupplierScore } from './po-scoring';

export type BuyAction = 'order' | 'expedite' | 'skip' | 'review';

export interface BuyPlanRowInput {
  sku: string;
  name: string;
  /** False drops the row from the plan; absent counts as active. */
  is_active?: boolean;
  stats: Pick<SkuStats, 'unit_cost' | 'rrp' | 'qty' | 'class_1'>;
  derived: Pick<
    DerivedSkuMetrics,
    | 'stockout_risk'
    | 'reorder'
    | 'suggested_buy_qty'
    | 'coverage_days'
    | 'forward_coverage_days'
    | 'basis'
    | 'coverage_target_days'
    | 'lead_time_days'
    | 'incoming_next_2m'
    | 'eoq_base_qty'
    | 'eoq_qty'
    | 'eoq_applied'
    | 'eoq_annual_demand'
    | 'pre_pack_qty'
    | 'min_order_qty'
    | 'min_applied'
    | 'pack_qty'
    | 'pack_applied'
  >;
  /** The product's brand attribute; empty when it has none (then no brand budget applies). */
  brand: string;
  reasons: Reason[];
  /** The SKU's performance label (caller-defined), when it has one. */
  label?: string | null;
  /** Whether ads are running on this SKU (any recent window spend). */
  has_ad_spend?: boolean;
  /** A role the row already carries (for example from classifyPerformance); a mapped label wins over it. */
  role?: LabelRole | null;
}

export interface BuyPlanLine {
  sku: string;
  name: string;
  brand: string;
  class_1: string;
  action: BuyAction;
  suggested_qty: number;
  /** The coverage-fill quantity before the EOQ top-up. */
  eoq_base_qty: number;
  /** True when the EOQ raised this line above its coverage-fill base. */
  eoq_applied: boolean;
  // ── Minimum order + pack quantities ──────────────
  /** The line quantity before pack rounding but AFTER the min floor. */
  pre_pack_qty: number;
  /** The effective minimum order quantity floor in force (buyer override); null when none. */
  min_order_qty: number | null;
  /** True when the minimum order quantity floor lifted suggested_qty. */
  min_applied: boolean;
  /** The effective pack size in force (buyer override or the row's reorder qty); null when none. */
  pack_qty: number | null;
  /** True when pack rounding lifted suggested_qty above pre_pack_qty. */
  pack_applied: boolean;
  unit_cost: number | null;
  order_cost: number | null;
  coverage_days: number | null;
  forward_coverage_days: number | null;
  basis: 'forward' | 'trailing';
  coverage_target_days: number;
  lead_time_days: number;
  supplier: { supplier: string; otif_pct: number | null; lead_time_p50_days: number | null } | null;
  reasons: Reason[];
  /** The SKU's performance label (caller-defined), when known. */
  label: string | null;
  /** Stocked out and its label maps to the 'priority' role: the top-priority buy. */
  is_priority: boolean;
}

export interface BuyPlanBudgetRow {
  brand: string;
  budget: number | null;
  stock_value: number;
  headroom_before: number | null;
  committed: number;
  headroom_after: number | null;
}

/**
 * Line-consolidation summary: how much the EOQ top-up reshaped the
 * plan. lines_raised counts lines the economic-order-quantity lifted above
 * their coverage-fill base; extra_units / extra_unit_cost is what those raises
 * add to the buy; trips_avoided_per_year + labour_saving_per_year quantify the
 * fixed receiving/unpacking/binning labour the bigger batches save (each raised
 * line: trips_before = D/base vs trips_after = D/new, delta summed; labour =
 * trips_avoided x handling_cost_per_line). METHODOLOGY note states the model.
 *
 * The supplier order constraints are counted SEPARATELY
 * from the EOQ raises so the plan totals stay explainable. The pipeline is
 * base -> post-EOQ -> post-min -> final(post-pack):
 *   - EOQ:  lines_raised / extra_units / extra_unit_cost (base -> post-EOQ),
 *   - min:  mins_applied / min_extra_units / min_extra_unit_cost (post-EOQ ->
 *           post-min), the units/cost attributable purely to the min floor,
 *   - pack: packs_applied / pack_extra_units / pack_extra_unit_cost (post-min ->
 *           final), the units/cost attributable purely to whole-pack rounding.
 */
export interface BuyPlanConsolidation {
  lines_raised: number;
  extra_units: number;
  extra_unit_cost: number;
  trips_avoided_per_year: number;
  labour_saving_per_year: number;
  handling_cost_per_line: number;
  /** Ordered lines whose quantity was lifted by the minimum order quantity floor. */
  mins_applied: number;
  /** Units added by the min floor alone (post-min - post-EOQ, summed). */
  min_extra_units: number;
  /** Cost of those min-added units (costed lines only). */
  min_extra_unit_cost: number;
  /** Ordered lines whose quantity was lifted by whole-pack rounding. */
  packs_applied: number;
  /** Units added by pack rounding alone (final - post-min, summed). */
  pack_extra_units: number;
  /** Cost of those pack-added units (costed lines only). */
  pack_extra_unit_cost: number;
  methodology: string;
}

export interface BuyPlan {
  lines: BuyPlanLine[];
  budgets: BuyPlanBudgetRow[];
  totals: {
    line_count: number;
    order_count: number;
    order_cost_total: number;
    skipped_for_budget: number;
    uncosted_lines: number;
    within_budget: boolean;
    /** EOQ line-consolidation summary. */
    consolidation: BuyPlanConsolidation;
  };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The consolidation methodology note the plan surfaces, stated once. */
export const CONSOLIDATION_METHODOLOGY =
  'Line consolidation raises a coverage-fill buy to the economic order quantity ' +
  'EOQ = sqrt(2 x D x K / h) (D = annual demand units, K = handling cost per line, ' +
  'h = holding rate x unit cost) whenever a bigger batch is cheaper than paying the ' +
  'fixed receiving/unpacking/binning labour on repeated tiny orders. It only ever ' +
  'RAISES a line and is capped at eoq_max_cover_days of forward cover; dead, ' +
  'clearance/discontinued SKUs and SKUs whose label the caller marks run-down are never escalated. ' +
  'Trips avoided per year = sum over raised lines of (D/base_qty - D/new_qty); ' +
  'the labour saving values each avoided trip at the handling cost per line. ' +
  'After the EOQ, two supplier order constraints apply in order: the minimum ' +
  'order quantity (a floor, buyer per-SKU min override) lifts a line up to at ' +
  'least the minimum, then pack rounding lifts it to a whole number of supplier ' +
  'packs (buyer per-SKU pack override first, else the reorder quantity on the row). ' +
  'The units and cost each adds are reported separately (mins_applied / ' +
  'min_extra_* and packs_applied / pack_extra_*) and are excluded from the EOQ ' +
  'trips/labour figures. A zero suggestion is never lifted - neither a minimum ' +
  'nor a pack can force an unwanted buy. ' +
  'Figures are annualised estimates from the current demand rate, not a forecast ' +
  'of realised orders.';

/**
 * Fold the per-line EOQ raises + min floors + pack roundings into the plan-wide
 * consolidation summary. Pure; takes only what it needs from each ordered line
 * so it can be unit-tested in isolation. A line contributes to the EOQ trips
 * math only when it was genuinely raised (eoq_applied) AND carries a positive
 * annual demand and base quantity (both true by construction when applied, but
 * guarded).
 *
 * The pipeline is base -> post-EOQ (eoq_qty) -> post-min (pre_pack_qty) ->
 * final (final_qty). min_applied / pack_applied describe the two supplier
 * constraints on top of the EOQ and default to "none" when absent, so
 * callers that pass neither keep their exact figures (pre_pack_qty defaults
 * to eoq_qty, final_qty to pre_pack_qty).
 */
export function summariseConsolidation(
  rows: Array<{
    eoq_applied: boolean;
    eoq_base_qty: number;
    eoq_qty: number;
    eoq_annual_demand: number;
    unit_cost: number | null;
    /** Line qty after the min floor, before pack rounding; defaults to eoq_qty. */
    pre_pack_qty?: number;
    /** True when the min floor lifted pre_pack_qty above eoq_qty. */
    min_applied?: boolean;
    /** Final line qty after pack rounding; defaults to pre_pack_qty. */
    final_qty?: number;
    /** True when pack rounding lifted final_qty above pre_pack_qty. */
    pack_applied?: boolean;
  }>,
  handlingCostPerLine: number,
): BuyPlanConsolidation {
  let linesRaised = 0;
  let extraUnits = 0;
  let extraUnitCost = 0;
  let tripsAvoided = 0;
  let minsApplied = 0;
  let minExtraUnits = 0;
  let minExtraUnitCost = 0;
  let packsApplied = 0;
  let packExtraUnits = 0;
  let packExtraUnitCost = 0;
  for (const r of rows) {
    // EOQ raise: base -> post-EOQ figure.
    if (r.eoq_applied && r.eoq_qty > r.eoq_base_qty) {
      linesRaised += 1;
      const extra = r.eoq_qty - r.eoq_base_qty;
      extraUnits += extra;
      if (r.unit_cost != null && r.unit_cost > 0) extraUnitCost += extra * r.unit_cost;
      if (r.eoq_annual_demand > 0 && r.eoq_base_qty > 0) {
        const tripsBefore = r.eoq_annual_demand / r.eoq_base_qty;
        const tripsAfter = r.eoq_annual_demand / r.eoq_qty;
        tripsAvoided += Math.max(0, tripsBefore - tripsAfter);
      }
    }
    const prePack = r.pre_pack_qty ?? r.eoq_qty;
    // Min floor: post-EOQ -> post-min, counted separately from the EOQ raise.
    if (r.min_applied === true && prePack > r.eoq_qty) {
      minsApplied += 1;
      const minExtra = prePack - r.eoq_qty;
      minExtraUnits += minExtra;
      if (r.unit_cost != null && r.unit_cost > 0) minExtraUnitCost += minExtra * r.unit_cost;
    }
    // Pack rounding: post-min -> final, counted separately again.
    const finalQty = r.final_qty ?? prePack;
    if (r.pack_applied === true && finalQty > prePack) {
      packsApplied += 1;
      const packExtra = finalQty - prePack;
      packExtraUnits += packExtra;
      if (r.unit_cost != null && r.unit_cost > 0) packExtraUnitCost += packExtra * r.unit_cost;
    }
  }
  return {
    lines_raised: linesRaised,
    extra_units: extraUnits,
    extra_unit_cost: r2(extraUnitCost),
    trips_avoided_per_year: r2(tripsAvoided),
    labour_saving_per_year: r2(tripsAvoided * Math.max(0, handlingCostPerLine)),
    handling_cost_per_line: handlingCostPerLine,
    mins_applied: minsApplied,
    min_extra_units: minExtraUnits,
    min_extra_unit_cost: r2(minExtraUnitCost),
    packs_applied: packsApplied,
    pack_extra_units: packExtraUnits,
    pack_extra_unit_cost: r2(packExtraUnitCost),
    methodology: CONSOLIDATION_METHODOLOGY,
  };
}

const RISK_ORDER: Record<string, number> = { STOCKOUT: 0, High: 1, Medium: 2, Low: 3 };

/**
 * Build the plan. Lines = queue members (reorder=true) with a positive
 * suggested buy OR stockouts fully covered by inbound (action 'expedite').
 * With budget_aware, lines are walked in queue order (most urgent first) and
 * each brand's headroom is consumed; a line that would overrun flips to
 * 'skip' with an OTB_EXHAUSTED reason instead of silently disappearing.
 */
export function buildBuyPlan(args: {
  rows: BuyPlanRowInput[];
  /** Stored under brandKey; looked up case-insensitively by the row's brand. */
  brandBudgets: Record<string, number>;
  brandStockValue: Record<string, number>;
  /** Supplier stats keyed by SKU (built from the incoming-PO lines). */
  supplierBySku: Map<string, SupplierScore>;
  budget_aware: boolean;
  /**
   * K per line for the consolidation labour-saving math, in store currency.
   * No default: absent means no labour saving is claimed (reported as 0).
   */
  handling_cost_per_line?: number;
  /**
   * Maps the caller's own label values to a role. A STOCKOUT row whose label
   * maps to 'priority' leads the plan. No default: without it (or without
   * labels on the rows) only a row that carries a role of its own is prioritised.
   */
  label_roles?: Readonly<Record<string, LabelRole>>;
}): BuyPlan {
  const roles = args.label_roles;
  // A stocked-out priority SKU is the most urgent thing a buyer can act on,
  // so it sorts ABOVE the ordinary STOCKOUT tier.
  const isPriority = (r: BuyPlanRowInput): boolean =>
    resolveLabelRole(r.label, roles, r.role) === 'priority' && r.derived.stockout_risk === 'STOCKOUT';
  const labelMapped = (r: BuyPlanRowInput): boolean =>
    roles != null && r.label != null && Object.prototype.hasOwnProperty.call(roles, r.label);
  const candidates = args.rows
    .filter((r) => r.is_active !== false && r.derived.reorder)
    .sort(
      (a, b) =>
        (isPriority(b) ? 1 : 0) - (isPriority(a) ? 1 : 0) ||
        (RISK_ORDER[a.derived.stockout_risk] ?? 9) - (RISK_ORDER[b.derived.stockout_risk] ?? 9) ||
        b.derived.suggested_buy_qty - a.derived.suggested_buy_qty,
    );

  const headroom = new Map<string, number | null>();
  const committed = new Map<string, number>();
  const stockValueOf = (brand: string) => args.brandStockValue[brand] ?? 0;
  // A row with no brand matches no budget, so its line is unconstrained.
  const budgetOf = (brand: string): number | undefined =>
    brand.trim() === '' ? undefined : brandLookup(args.brandBudgets, brand);
  const headroomOf = (brand: string): number | null => {
    if (!headroom.has(brand)) {
      const budget = budgetOf(brand);
      headroom.set(brand, typeof budget === 'number' && budget > 0 ? Math.max(0, budget - stockValueOf(brand)) : null);
    }
    return headroom.get(brand) ?? null;
  };

  const lines: BuyPlanLine[] = [];
  let orderCostTotal = 0;
  let skippedForBudget = 0;
  let uncosted = 0;

  for (const row of candidates) {
    const qty = row.derived.suggested_buy_qty;
    const cost = row.stats.unit_cost;
    const orderCost = cost != null ? r2(qty * cost) : null;
    const supplier = args.supplierBySku.get(row.sku) ?? null;
    const reasons = [...row.reasons];
    const priority = isPriority(row);
    if (priority) {
      const how = labelMapped(row) ? `labelled priority (${row.label})` : 'priority role';
      reasons.unshift(reason('PRIORITY_STOCKOUT', `stocked out, ${how} - buy first`, undefined));
    }
    // Ad spend running on a stocked-out SKU is money burning with nothing to
    // sell: flag it as waste so the buyer chases stock (or pauses the ad).
    if (row.has_ad_spend && row.derived.stockout_risk === 'STOCKOUT') {
      reasons.push(reason('AD_WASTE', 'ads still running while stocked out - pause the ad or expedite stock'));
    }

    let action: BuyAction;
    if (qty <= 0) {
      // At-risk but nothing to order: inbound covers it - chase the PO, not a new order.
      action = 'expedite';
    } else if (cost == null) {
      action = 'review';
      uncosted += 1;
      reasons.push(reason('UNCOSTED', 'no unit cost recorded - price the order before raising it'));
    } else if (args.budget_aware) {
      const room = headroomOf(row.brand);
      if (room != null && orderCost != null && orderCost > room - (committed.get(row.brand) ?? 0)) {
        action = 'skip';
        skippedForBudget += 1;
        reasons.push(
          reason(
            'OTB_EXHAUSTED',
            `brand budget headroom exhausted (${r2(Math.max(0, room - (committed.get(row.brand) ?? 0)))} left, line needs ${orderCost})`,
            orderCost,
          ),
        );
      } else {
        action = 'order';
      }
    } else {
      action = 'order';
    }

    if (action === 'order' && orderCost != null) {
      committed.set(row.brand, (committed.get(row.brand) ?? 0) + orderCost);
      orderCostTotal += orderCost;
    }

    lines.push({
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      class_1: row.stats.class_1,
      action,
      suggested_qty: qty,
      eoq_base_qty: row.derived.eoq_base_qty,
      eoq_applied: row.derived.eoq_applied,
      pre_pack_qty: row.derived.pre_pack_qty,
      min_order_qty: row.derived.min_order_qty,
      min_applied: row.derived.min_applied,
      pack_qty: row.derived.pack_qty,
      pack_applied: row.derived.pack_applied,
      unit_cost: cost,
      order_cost: orderCost,
      coverage_days: row.derived.coverage_days,
      forward_coverage_days: row.derived.forward_coverage_days,
      basis: row.derived.basis,
      coverage_target_days: row.derived.coverage_target_days,
      lead_time_days: row.derived.lead_time_days,
      supplier: supplier
        ? { supplier: supplier.supplier, otif_pct: supplier.otif_pct, lead_time_p50_days: supplier.lead_time_p50_days }
        : null,
      reasons,
      label: row.label ?? null,
      is_priority: priority,
    });
  }

  const budgets: BuyPlanBudgetRow[] = [];
  const brands = new Set(lines.map((l) => l.brand));
  for (const brand of [...brands].sort()) {
    const budget = budgetOf(brand);
    const hasBudget = typeof budget === 'number' && budget > 0;
    const before = hasBudget ? Math.max(0, budget - stockValueOf(brand)) : null;
    const spent = committed.get(brand) ?? 0;
    budgets.push({
      brand,
      budget: hasBudget ? budget : null,
      stock_value: r2(stockValueOf(brand)),
      headroom_before: before != null ? r2(before) : null,
      committed: r2(spent),
      headroom_after: before != null ? r2(Math.max(0, before - spent)) : null,
    });
  }

  // Consolidation summary over the lines that would actually be ORDERED (a
  // budget-skipped line isn't a buy, so it shouldn't claim labour savings).
  // The pipeline is base -> post-EOQ (eoq_qty) -> post-min (pre_pack_qty) ->
  // final (suggested_qty); the EOQ trips math runs on the post-EOQ figure so
  // it isn't inflated by the min/pack, whose contributions are counted
  // separately.
  const demandBySku = new Map(args.rows.map((r) => [r.sku, r.derived.eoq_annual_demand]));
  const eoqQtyBySku = new Map(args.rows.map((r) => [r.sku, r.derived.eoq_qty]));
  const consolidation = summariseConsolidation(
    lines
      .filter((l) => l.action === 'order')
      .map((l) => ({
        eoq_applied: l.eoq_applied,
        eoq_base_qty: l.eoq_base_qty,
        eoq_qty: eoqQtyBySku.get(l.sku) ?? l.pre_pack_qty,
        eoq_annual_demand: demandBySku.get(l.sku) ?? 0,
        unit_cost: l.unit_cost,
        pre_pack_qty: l.pre_pack_qty,
        min_applied: l.min_applied,
        final_qty: l.suggested_qty,
        pack_applied: l.pack_applied,
      })),
    args.handling_cost_per_line ?? 0,
  );

  return {
    lines,
    budgets,
    totals: {
      line_count: lines.length,
      order_count: lines.filter((l) => l.action === 'order').length,
      order_cost_total: r2(orderCostTotal),
      skipped_for_budget: skippedForBudget,
      uncosted_lines: uncosted,
      within_budget: skippedForBudget === 0,
      consolidation,
    },
  };
}

// ── What-if simulation ─────────────────────────────────────────────────────

export interface SimulateLineInput {
  sku: string;
  qty: number;
}

export interface SimulatedLine {
  sku: string;
  buy_qty: number;
  unit_cost: number | null;
  order_cost: number | null;
  coverage_days_before: number | null;
  coverage_days_after: number | null;
  forward_coverage_days_before: number | null;
  risk_before: string;
  risk_after: string;
  basis: 'forward' | 'trailing';
}

/**
 * Simulate buying the given quantities: recompute cover + risk per line with
 * the stock added, and total the cash commitment. Forward cover after a buy
 * is approximated by scaling trailing math when no forecast walk is available
 * to the caller - pass a recompute callback (withExtraUnits) so both bases use
 * the real derivation. Pure: callers supply everything.
 */
export function simulateBuy(args: {
  lines: SimulateLineInput[];
  bySku: Map<
    string,
    {
      stats: Pick<SkuStats, 'unit_cost' | 'qty'>;
      derived: Pick<DerivedSkuMetrics, 'stockout_risk' | 'coverage_days' | 'forward_coverage_days' | 'basis'>;
      /** Re-derive risk + cover with extra units on hand (the real metric fn). */
      withExtraUnits: (extra: number) => {
        stockout_risk: string;
        coverage_days: number | null;
        forward_coverage_days: number | null;
      };
    }
  >;
}): {
  lines: SimulatedLine[];
  unknown_skus: string[];
  totals: { order_cost_total: number; uncosted_lines: number };
} {
  const out: SimulatedLine[] = [];
  const unknown: string[] = [];
  let total = 0;
  let uncosted = 0;
  for (const line of args.lines) {
    const target = args.bySku.get(line.sku);
    if (!target) {
      unknown.push(line.sku);
      continue;
    }
    const qty = Math.max(0, Math.round(line.qty));
    const after = target.withExtraUnits(qty);
    const cost = target.stats.unit_cost;
    const orderCost = cost != null ? r2(qty * cost) : null;
    if (orderCost != null) total += orderCost;
    else uncosted += 1;
    out.push({
      sku: line.sku,
      buy_qty: qty,
      unit_cost: cost,
      order_cost: orderCost,
      coverage_days_before:
        target.derived.basis === 'forward' ? target.derived.forward_coverage_days : target.derived.coverage_days,
      coverage_days_after:
        target.derived.basis === 'forward' ? after.forward_coverage_days : after.coverage_days,
      forward_coverage_days_before: target.derived.forward_coverage_days,
      risk_before: target.derived.stockout_risk,
      risk_after: after.stockout_risk,
      basis: target.derived.basis,
    });
  }
  return { lines: out, unknown_skus: unknown, totals: { order_cost_total: r2(total), uncosted_lines: uncosted } };
}

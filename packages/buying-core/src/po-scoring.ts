/**
 * buying-core - purchase-order performance scoring (pure).
 *
 * Turns one raw purchase-order row into a graded, RAG-coloured, signalled
 * PoScored record, and rolls PoScored rows up per supplier into a scorecard.
 * No I/O, no Date.now() - the SAME functions power every tool
 * and screen, so a number on the tab and the same
 * number from a tool can never disagree. Nothing here is persisted.
 *
 * The thresholds are calibrated for durable-goods retail
 * buying. Every ratio guards its denominator: a divide by zero yields null
 * (unknown), never NaN or Infinity. A PO still fully incoming (nothing received
 * yet) has no sell-through to judge, so it grades C / amber / watch until stock
 * lands.
 */

import { reason, type Reason } from './reason-codes';

// ── Raw + derived shapes ──────────────────────────────────────────────────

/**
 * One purchase order as the caller supplies it,
 * after normalisation. Money columns are dollars; unit / day / aged counts are
 * whole numbers. Dates are YYYY-MM-DD or null (the feed had no date). Any
 * numeric field can be null when the feed cell was empty (unknown, not zero) -
 * scorePo coerces the money nulls to 0 where the spec says so, and guards the
 * count nulls to 0 for the unit maths.
 */
export interface PurchaseOrderRow {
  po_number: string;
  supplier: string;
  ordered_date: string | null;
  original_eta: string | null;
  latest_eta: string | null;
  units_total: number;
  units_incoming: number;
  units_in_stock: number;
  units_sold: number;
  units_cancelled: number;
  total_cost: number | null;
  sold_cost: number | null;
  sold_revenue: number | null;
  avg_days_to_sell: number | null;
  oldest_unsold_days: number | null;
  unsold_over_90d: number;
  unsold_over_180d: number;
}

export type Grade = 'A' | 'B' | 'C' | 'D';
export type Rag = 'green' | 'amber' | 'red';
export type Signal = 'reorder' | 'watch' | 'markdown';

/** A scored purchase order: the raw row plus every derived metric. */
export interface PoScored extends PurchaseOrderRow {
  /** Units that have actually landed (in stock + sold) - the sell-through base. */
  received: number;
  /** units_sold / received * 100; null when nothing has been received yet. */
  sell_through_pct: number | null;
  /** sold_revenue - sold_cost (both coerced to 0 when null). */
  margin: number;
  /** margin / sold_revenue * 100; null when there is no sold revenue. */
  margin_pct: number | null;
  /**
   * Margin returned per $1 of landed cost (margin / total_cost); null when no
   * cost. NOTE: this is NOT classic GMROI (margin over AVERAGE inventory
   * investment, annualized) - do not compare it to the industry 1.0/2.0/3.0
   * bands. The honest name; `gmroi` remains as a deprecated alias.
   */
  margin_per_landed_dollar: number | null;
  /** @deprecated alias of margin_per_landed_dollar (kept one minor version). */
  gmroi: number | null;
  /** unsold_over_90d / units_in_stock * 100; 0 when nothing is in stock. */
  aged_over_90_pct: number;
  /** Any units aged past 180 days unsold. */
  has_dead_stock: boolean;
  /** latest_eta - original_eta in days (positive = slipped later); null when either is missing. */
  eta_slip_days: number | null;
  /** Slip <= 0 against the original ETA; null when either ETA is missing. */
  on_time: boolean | null;
  /** ordered_date -> latest_eta in days, only once stock has landed (received > 0); else null. */
  realized_lead_time_days: number | null;
  grade: Grade;
  rag: Rag;
  signal: Signal;
  /** Structured WHY for the grade + signal (same numbers that drove them). */
  reasons: Reason[];
}

/** Per-supplier scorecard row (rollup of that supplier's PoScored rows). */
export interface SupplierScore {
  supplier: string;
  po_count: number;
  units_total: number;
  units_received: number;
  units_sold: number;
  total_cost: number;
  margin: number;
  /** Weighted sell-through: Σsold / Σreceived * 100; null when nothing received. */
  sell_through_pct: number | null;
  /** Mean margin-per-landed-dollar across the supplier's POs that have one. */
  avg_gmroi: number | null;
  /** Units still in stock aged past 180 days across the supplier's POs. */
  dead_stock_units: number;
  /** Share of POs delivered by the original ETA, % (POs with both ETAs only); null when none. */
  otif_pct: number | null;
  /** Mean ETA slip in days across POs with both ETAs; null when none. */
  avg_slip_days: number | null;
  /** Realized order->arrival lead time, median / 90th pct days; null when no landed POs. */
  lead_time_p50_days: number | null;
  lead_time_p90_days: number | null;
  /** Most recent ordered_date across the supplier's POs; null when none dated. */
  last_po_date: string | null;
  tier: SupplierTier;
}

export type SupplierTier = 'Preferred' | 'Strong' | 'Acceptable' | 'At risk';

// ── Helpers ────────────────────────────────────────────────────────────────

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Coerce a possibly-null numeric field to a finite number (default 0). */
function num(v: number | null | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Grade → points for supplier-tier averaging (A=4 … D=1). */
const GRADE_POINTS: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 };

/** "small" in-stock: a reorder signal wants stock nearly gone (sold through). */
const REORDER_INSTOCK_MAX = 5;

/** An ETA slip past this many days is worth a SUPPLIER_LATE reason. */
export const SUPPLIER_LATE_DAYS = 7;

/**
 * Whole days from a to b (YYYY-MM-DD strings); positive when b is later.
 * null when either side is missing/unparseable - dates in this feed can be
 * empty cells, and a fabricated 0 would read as "on time".
 */
export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/** p-th percentile (0..1) of a numeric list by nearest-rank; null on empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score one purchase order. Every branch is total: sell-through is null only
 * when nothing has been received; margin coerces null money to 0; the three
 * ratios (margin_pct, gmroi) guard their denominators to null; aged_over_90_pct
 * is 0 when nothing is in stock. Grade / RAG / signal follow the sporting-goods
 * thresholds documented inline.
 */
/**
 * Days a PO's oldest unsold unit must have been in stock before the PO is
 * graded on sell-through and margin. 60 is about two months of selling time.
 */
export const PO_JUDGE_MIN_DAYS = 60;

/** Received stock whose oldest unsold unit landed under PO_JUDGE_MIN_DAYS ago. */
function isTooEarlyToJudge(row: Pick<PurchaseOrderRow, 'oldest_unsold_days'>): boolean {
  const d = row.oldest_unsold_days;
  return d != null && Number.isFinite(d) && d < PO_JUDGE_MIN_DAYS;
}

export function scorePo(row: PurchaseOrderRow): PoScored {
  const unitsInStock = num(row.units_in_stock);
  const unitsSold = num(row.units_sold);
  const received = unitsInStock + unitsSold;

  const sellThrough = received > 0 ? r2((unitsSold / received) * 100) : null;

  const soldRevenue = num(row.sold_revenue);
  const soldCost = num(row.sold_cost);
  const totalCost = num(row.total_cost);
  const margin = r2(soldRevenue - soldCost);

  const marginPct = soldRevenue > 0 ? r2((margin / soldRevenue) * 100) : null;
  const gmroi = totalCost > 0 ? r2(margin / totalCost) : null;

  const agedOver90Pct = unitsInStock > 0 ? r2((num(row.unsold_over_90d) / unitsInStock) * 100) : 0;
  const hasDeadStock = num(row.unsold_over_180d) > 0;

  // A PO still fully incoming (nothing received yet) has no sell-through and no
  // realised margin to judge, so it must not be read as a failure just because
  // its margin-per-dollar is 0. It parks at C / amber / watch until stock lands.
  // So does stock that landed under PO_JUDGE_MIN_DAYS ago: it has had no
  // time to sell, and grading it on the old-stock thresholds recommended fresh
  // deliveries for markdown.
  // An unknown landing age is judged as before, never exempted by a missing value.
  const tooEarly = received === 0 || isTooEarlyToJudge(row);
  const grade: Grade = tooEarly ? 'C' : gradeFor(sellThrough, gmroi, unitsInStock, agedOver90Pct, hasDeadStock);
  const rag = ragFor(grade);
  const signal: Signal = tooEarly ? 'watch' : signalFor(sellThrough, gmroi, unitsInStock, agedOver90Pct, hasDeadStock);

  const etaSlip = daysBetween(row.original_eta, row.latest_eta);
  const scored: PoScored = {
    ...row,
    units_total: num(row.units_total),
    units_incoming: num(row.units_incoming),
    units_in_stock: unitsInStock,
    units_sold: unitsSold,
    units_cancelled: num(row.units_cancelled),
    total_cost: row.total_cost,
    sold_cost: row.sold_cost,
    sold_revenue: row.sold_revenue,
    unsold_over_90d: num(row.unsold_over_90d),
    unsold_over_180d: num(row.unsold_over_180d),
    received,
    sell_through_pct: sellThrough,
    margin,
    margin_pct: marginPct,
    margin_per_landed_dollar: gmroi,
    gmroi,
    aged_over_90_pct: agedOver90Pct,
    has_dead_stock: hasDeadStock,
    eta_slip_days: etaSlip,
    on_time: etaSlip == null ? null : etaSlip <= 0,
    realized_lead_time_days: received > 0 ? daysBetween(row.ordered_date, row.latest_eta) : null,
    grade,
    rag,
    signal,
    reasons: [],
  };
  scored.reasons = poReasons(scored);
  return scored;
}

/**
 * Structured reasons for a PO's grade + signal, from the same thresholds
 * gradeFor/signalFor used. Ordered by what the buyer acts on first.
 */
function poReasons(po: PoScored): Reason[] {
  const out: Reason[] = [];
  const st = po.sell_through_pct;
  const gm = po.margin_per_landed_dollar;

  if (po.received === 0) {
    out.push(reason('STILL_INCOMING', 'nothing received yet - no sell-through to judge'));
  } else if (isTooEarlyToJudge(po)) {
    out.push(
      reason(
        'TOO_EARLY_TO_JUDGE',
        `stock landed ${po.oldest_unsold_days} days ago (< ${PO_JUDGE_MIN_DAYS}) - too early to judge sell-through`,
        po.oldest_unsold_days ?? undefined,
      ),
    );
  } else {
    if (st != null && st >= 70) out.push(reason('SELL_THROUGH_STRONG', `sell-through ${st.toFixed(0)}% of received`, st));
    if (st != null && st < 40) out.push(reason('SELL_THROUGH_LOW', `sell-through ${st.toFixed(0)}% < 40%`, st));
    if (gm != null && gm < 0.2) out.push(reason('MARGIN_PER_DOLLAR_LOW', `margin $${gm.toFixed(2)} per $1 landed < $0.20`, gm));
    if (po.signal === 'reorder' && po.units_in_stock <= REORDER_INSTOCK_MAX) {
      out.push(reason('STOCK_NEARLY_GONE', `${po.units_in_stock} units left in stock`, po.units_in_stock));
    }
    if (po.units_in_stock > 0 && po.aged_over_90_pct > 15) {
      out.push(reason('AGED_STOCK_SHARE_HIGH', `${po.aged_over_90_pct.toFixed(0)}% of in-stock aged past 90d`, po.aged_over_90_pct));
    }
    if (po.has_dead_stock) {
      out.push(reason('DEAD_STOCK_180', `${po.unsold_over_180d} units unsold past 180d`, po.unsold_over_180d));
    }
  }
  if (po.eta_slip_days != null && po.eta_slip_days > SUPPLIER_LATE_DAYS) {
    out.push(reason('SUPPLIER_LATE', `ETA slipped ${po.eta_slip_days}d past the original`, po.eta_slip_days));
  }
  return out;
}

// ── Inventory aging by landed value (from the PO aged-unsold buckets) ──────

/**
 * Roll the PO-level aged-unsold counts into inventory-wide aging by landed
 * value. Feed grain limits the buckets to 0-90 / 91-180 / 180+ (the feed
 * carries only the two aged counts, not a full five-bucket split). Value =
 * bucket units * the PO's per-unit landed cost; POs with no cost contribute
 * units but no value (uncosted_units so the total stays honest).
 */
export interface AgedValueBuckets {
  fresh_value: number;
  aged_91_180_value: number;
  aged_over_180_value: number;
  fresh_units: number;
  aged_91_180_units: number;
  aged_over_180_units: number;
  /** Share of in-stock landed value aged past 90 days, %; null when no costed stock. */
  pct_value_aged_90d: number | null;
  uncosted_units: number;
}

export function agedValueBuckets(scored: PoScored[]): AgedValueBuckets {
  let freshV = 0;
  let midV = 0;
  let oldV = 0;
  let freshU = 0;
  let midU = 0;
  let oldU = 0;
  let uncosted = 0;
  for (const po of scored) {
    const inStock = po.units_in_stock;
    if (inStock <= 0) continue;
    const over90 = Math.min(po.unsold_over_90d, inStock);
    const over180 = Math.min(po.unsold_over_180d, over90);
    const mid = over90 - over180;
    const fresh = inStock - over90;
    const cost = num(po.total_cost);
    const perUnit = cost > 0 && po.units_total > 0 ? cost / po.units_total : null;
    if (perUnit == null) {
      uncosted += inStock;
    } else {
      freshV += fresh * perUnit;
      midV += mid * perUnit;
      oldV += over180 * perUnit;
    }
    freshU += fresh;
    midU += mid;
    oldU += over180;
  }
  const totalV = freshV + midV + oldV;
  return {
    fresh_value: r2(freshV),
    aged_91_180_value: r2(midV),
    aged_over_180_value: r2(oldV),
    fresh_units: freshU,
    aged_91_180_units: midU,
    aged_over_180_units: oldU,
    pct_value_aged_90d: totalV > 0 ? r2(((midV + oldV) / totalV) * 100) : null,
    uncosted_units: uncosted,
  };
}

/**
 * Grade band. Order matters: A and B are the "healthy" tiers, then a C rescue
 * band, then the D failure band. A PO still fully incoming (received == 0, so
 * sell_through is null) is graded C - there is no sell-through to judge yet.
 */
function gradeFor(
  sellThrough: number | null,
  gmroi: number | null,
  unitsInStock: number,
  agedOver90Pct: number,
  hasDeadStock: boolean,
): Grade {
  const st = sellThrough;
  const gm = gmroi;

  // D / red first when a hard failure is present, so a dead-stock or
  // deeply-underselling PO can never be rescued into C by the aged-stock clause.
  if ((st != null && st < 40) || (gm != null && gm < 0.2) || hasDeadStock) return 'D';

  // A / green: strong sell-through AND strong GMROI.
  if (st != null && st >= 70 && gm != null && gm >= 0.5) return 'A';
  // B / green: solid sell-through AND acceptable GMROI.
  if (st != null && st >= 55 && gm != null && gm >= 0.35) return 'B';

  // C / amber rescue: decent sell-through, OR stock that isn't ageing.
  if ((st != null && st >= 40) || (unitsInStock > 0 && agedOver90Pct <= 15)) return 'C';

  // Everything else that reached here (received something, no hard failure, but
  // below the B bar) lands at C. The fully-incoming case is handled upstream.
  return 'C';
}

/** RAG follows the grade: A/B green, C amber, D red. */
function ragFor(grade: Grade): Rag {
  if (grade === 'A' || grade === 'B') return 'green';
  if (grade === 'C') return 'amber';
  return 'red';
}

/**
 * Action signal. reorder when it sold strongly at a strong margin and stock is
 * nearly gone; markdown when stock is sitting and not moving (weak sell-through,
 * ageing, or dead stock); otherwise watch (incl. still-incoming POs).
 */
function signalFor(
  sellThrough: number | null,
  gmroi: number | null,
  unitsInStock: number,
  agedOver90Pct: number,
  hasDeadStock: boolean,
): Signal {
  const st = sellThrough;
  const gm = gmroi;

  if (st != null && st >= 70 && gm != null && gm >= 0.5 && unitsInStock <= REORDER_INSTOCK_MAX) {
    return 'reorder';
  }
  if (unitsInStock > 0 && ((st != null && st < 40) || agedOver90Pct > 15 || hasDeadStock)) {
    return 'markdown';
  }
  return 'watch';
}

// ── Supplier rollup ──────────────────────────────────────────────────────────

/**
 * Group scored POs by supplier into a scorecard. Sell-through is WEIGHTED
 * (Σsold / Σreceived), GMROI is the simple mean over the POs that have one, and
 * the tier comes from the supplier's average grade points (A=4 … D=1). Sorted
 * by total cost descending (biggest spend first).
 */
export function rollupSuppliers(scored: PoScored[]): SupplierScore[] {
  interface Acc {
    supplier: string;
    po_count: number;
    units_total: number;
    units_received: number;
    units_sold: number;
    total_cost: number;
    margin: number;
    dead_stock_units: number;
    gmroiSum: number;
    gmroiCount: number;
    gradePoints: number;
    onTimeCount: number;
    etaKnownCount: number;
    slipSum: number;
    leadTimes: number[];
    lastPoDate: string | null;
  }

  const acc = new Map<string, Acc>();
  for (const po of scored) {
    const key = po.supplier;
    const a =
      acc.get(key) ??
      {
        supplier: key,
        po_count: 0,
        units_total: 0,
        units_received: 0,
        units_sold: 0,
        total_cost: 0,
        margin: 0,
        dead_stock_units: 0,
        gmroiSum: 0,
        gmroiCount: 0,
        gradePoints: 0,
        onTimeCount: 0,
        etaKnownCount: 0,
        slipSum: 0,
        leadTimes: [],
        lastPoDate: null,
      };
    a.po_count += 1;
    a.units_total += po.units_total;
    a.units_received += po.received;
    a.units_sold += po.units_sold;
    a.total_cost += num(po.total_cost);
    a.margin += po.margin;
    a.dead_stock_units += po.unsold_over_180d;
    if (po.gmroi != null) {
      a.gmroiSum += po.gmroi;
      a.gmroiCount += 1;
    }
    a.gradePoints += GRADE_POINTS[po.grade];
    if (po.on_time != null && po.eta_slip_days != null) {
      a.etaKnownCount += 1;
      a.slipSum += po.eta_slip_days;
      if (po.on_time) a.onTimeCount += 1;
    }
    if (po.realized_lead_time_days != null && po.realized_lead_time_days > 0) {
      a.leadTimes.push(po.realized_lead_time_days);
    }
    if (po.ordered_date && (a.lastPoDate == null || po.ordered_date > a.lastPoDate)) {
      a.lastPoDate = po.ordered_date;
    }
    acc.set(key, a);
  }

  const out: SupplierScore[] = [];
  for (const a of acc.values()) {
    const sellThrough = a.units_received > 0 ? r2((a.units_sold / a.units_received) * 100) : null;
    const avgGmroi = a.gmroiCount > 0 ? r2(a.gmroiSum / a.gmroiCount) : null;
    const avgGradePoints = a.po_count > 0 ? a.gradePoints / a.po_count : 0;
    out.push({
      supplier: a.supplier,
      po_count: a.po_count,
      units_total: a.units_total,
      units_received: a.units_received,
      units_sold: a.units_sold,
      total_cost: r2(a.total_cost),
      margin: r2(a.margin),
      sell_through_pct: sellThrough,
      avg_gmroi: avgGmroi,
      dead_stock_units: a.dead_stock_units,
      otif_pct: a.etaKnownCount > 0 ? r2((a.onTimeCount / a.etaKnownCount) * 100) : null,
      avg_slip_days: a.etaKnownCount > 0 ? r2(a.slipSum / a.etaKnownCount) : null,
      lead_time_p50_days: percentile(a.leadTimes, 0.5),
      lead_time_p90_days: percentile(a.leadTimes, 0.9),
      last_po_date: a.lastPoDate,
      tier: tierFor(avgGradePoints),
    });
  }
  return out.sort((x, y) => y.total_cost - x.total_cost);
}

/** Supplier tier from average grade points (A=4, B=3, C=2, D=1). */
function tierFor(avgGradePoints: number): SupplierTier {
  if (avgGradePoints >= 3.5) return 'Preferred';
  if (avgGradePoints >= 2.75) return 'Strong';
  if (avgGradePoints >= 2.0) return 'Acceptable';
  return 'At risk';
}

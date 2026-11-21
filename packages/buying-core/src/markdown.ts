/**
 * buying-core - markdown candidates (pure).
 *
 * Ranks the stock a buyer should consider clearing: dead SKUs, aged stock,
 * and heavy overcover, each priced (landed value at stake) with a suggested
 * first markdown depth and the margin floor (unit cost - never sell below it
 * without calling it a write-off). NOTE: the input carries no markdown-value
 * history, so a markdown-%-of-sales KPI is not computable here; this module
 * ranks candidates only.
 *
 * Depth ladder (markdown_depths, small first cut, step up). Defaults:
 *   aged past aged_days[0] or overcover .. 20%
 *   aged past aged_days[1] ............... 40%
 *   dead (stock, zero demand) ............ 50%
 */

import type { DerivedSkuMetrics, SkuStats } from './buyer-metrics';
import { reason, type Reason } from './reason-codes';

export interface MarkdownCandidate {
  sku: string;
  name: string;
  brand: string;
  class_1: string;
  qty: number;
  unit_cost: number | null;
  /** Landed value sitting in this SKU (qty * cost); null when uncosted. */
  value_at_stake: number | null;
  rrp: number;
  age_days: number | null;
  /** Effective cover driving the judgement (forward when available). */
  coverage_days: number | null;
  is_dead: boolean;
  suggested_depth_pct: number;
  /** Suggested first markdown price (rrp * (1 - depth)); null when rrp unknown. */
  suggested_price: number | null;
  /** Unit cost: below this the exit is a write-off, not a markdown. */
  margin_floor: number | null;
  reasons: Reason[];
}

/** First markdown depth per condition, each a fraction of rrp (0..1). */
export interface MarkdownDepths {
  /** Dead stock (on hand, zero demand). Default 0.5. */
  dead: number;
  /** Oldest item past the second aged_days threshold. Default 0.4. */
  aged_180: number;
  /** Oldest item past the first aged_days threshold, or overcover only. Default 0.2. */
  default: number;
}

export const DEFAULT_MARKDOWN_DEPTHS: MarkdownDepths = { dead: 0.5, aged_180: 0.4, default: 0.2 };

export interface MarkdownInput {
  rows: Array<{
    sku: string;
    name: string;
    /** False drops the row; absent counts as active. */
    is_active?: boolean;
    brand: string;
    stats: Pick<SkuStats, 'qty' | 'unit_cost' | 'rrp' | 'age_of_oldest_item_days' | 'class_1'>;
    derived: Pick<DerivedSkuMetrics, 'is_dead' | 'coverage_days' | 'forward_coverage_days' | 'basis'>;
  }>;
  /** Cover past this many days counts as overcover (default 270 - ~9 months). */
  overcover_days?: number;
  /**
   * Aged-stock thresholds in days, [first, second]: older than the first is
   * AGED_FIRST, older than the second is AGED_SECOND. Default [90, 180].
   */
  aged_days?: [number, number];
  /** Markdown depth per condition; any key left out keeps its default (0.5 / 0.4 / 0.2). */
  markdown_depths?: Partial<MarkdownDepths>;
}

export const DEFAULT_OVERCOVER_DAYS = 270;

const DEFAULT_AGED_DAYS: [number, number] = [90, 180];

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function markdownCandidates(input: MarkdownInput): MarkdownCandidate[] {
  const overcover = input.overcover_days ?? DEFAULT_OVERCOVER_DAYS;
  const [agedFirst, agedSecond] = input.aged_days ?? DEFAULT_AGED_DAYS;
  const depths: MarkdownDepths = { ...DEFAULT_MARKDOWN_DEPTHS, ...input.markdown_depths };
  const out: MarkdownCandidate[] = [];
  for (const row of input.rows) {
    if (row.is_active === false || row.stats.qty <= 0) continue;
    const age = row.stats.age_of_oldest_item_days;
    const cover = row.derived.basis === 'forward' ? row.derived.forward_coverage_days : row.derived.coverage_days;
    const dead = row.derived.is_dead;
    const aged180 = age != null && age > agedSecond;
    const aged90 = age != null && age > agedFirst && !aged180;
    const over = cover != null && cover > overcover;
    if (!dead && !aged180 && !aged90 && !over) continue;

    const reasons: Reason[] = [];
    let depth = depths.default;
    if (dead) {
      depth = depths.dead;
      reasons.push(reason('DEAD_STOCK', `${Math.round(row.stats.qty)} units, no demand trailing or forecast`, row.stats.qty));
    } else if (aged180) {
      depth = depths.aged_180;
      reasons.push(reason('AGED_SECOND', `oldest item ${Math.round(age!)}d old`, age!));
    } else if (aged90) {
      reasons.push(reason('AGED_FIRST', `oldest item ${Math.round(age!)}d old`, age!));
    }
    if (over && cover != null) {
      // OVERCOVER, not BELOW_TARGET_COVER (that code means a cover
      // SHORTFALL - the opposite of this excess-stock case).
      reasons.push(reason('OVERCOVER', `cover ${Math.round(cover)}d far past ${overcover}d - capital parked`, cover));
    }

    const cost = row.stats.unit_cost;
    out.push({
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      class_1: row.stats.class_1,
      qty: row.stats.qty,
      unit_cost: cost,
      value_at_stake: cost != null ? r2(row.stats.qty * cost) : null,
      rrp: row.stats.rrp,
      age_days: age,
      coverage_days: cover,
      is_dead: dead,
      suggested_depth_pct: Math.round(depth * 100),
      suggested_price: row.stats.rrp > 0 ? r2(row.stats.rrp * (1 - depth)) : null,
      margin_floor: cost,
      reasons,
    });
  }
  return out.sort((a, b) => (b.value_at_stake ?? 0) - (a.value_at_stake ?? 0));
}

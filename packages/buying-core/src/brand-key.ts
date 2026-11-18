/**
 * buying-core - the ONE canonical brand key.
 *
 * Brand-keyed buyer state (stock-value budgets, OTB plan cells, brand
 * coverage + lead-time overrides) is STORED under brandKey(label): trimmed and
 * upper-cased. The caller's rows may carry brand labels in mixed case
 * ("Brand B", "Brand P and Q"), so a read must never index those maps by
 * the raw row label: exact indexing misses every mixed-case brand. Every
 * brand-keyed READ goes through
 * brandLookup; class keys stay exact (they were never upper-cased).
 */

/** The canonical key for a brand label: trimmed, upper-cased. */
export function brandKey(label: string): string {
  return label.trim().toUpperCase();
}

/** Own-property read, so a brand named like an Object.prototype member never resolves to it. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Read a brand-keyed map case-insensitively: the canonical key every write
 * stores, else an exact key (a map the caller keyed by the raw label).
 */
export function brandLookup<T>(map: Readonly<Record<string, T>>, label: string): T | undefined {
  return own(map, brandKey(label)) ?? own(map, label);
}

/** How a stored brand key matches, for callers that describe their brand-keyed writes (budget, OTB plan, overrides). */
export const BRAND_KEY_NOTE =
  'brand keys are stored upper-cased and match the row\'s brand label case-insensitively ("BRAND B" applies to the "Brand B" row)';

/**
 * Re-key brand-dimension rows stored under brandKey onto the label the
 * caller's rows carry, so an OTB plan nets against the brand's real stock
 * instead of appearing as a second, phantom upper-cased key. A row for a
 * brand absent from the caller's rows keeps its stored key.
 */
export function onRowLabels<T extends { key: string }>(rows: T[], rowLabels: Iterable<string>): T[] {
  const labelByKey = new Map<string, string>();
  for (const label of rowLabels) {
    const k = brandKey(label);
    if (!labelByKey.has(k)) labelByKey.set(k, label);
  }
  return rows.map((r) => {
    const label = labelByKey.get(brandKey(r.key));
    return label !== undefined && label !== r.key ? { ...r, key: label } : r;
  });
}

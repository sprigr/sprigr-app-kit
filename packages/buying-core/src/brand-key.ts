/**
 * buying-core - the ONE canonical brand key.
 *
 * Brand-keyed buyer state (stock-value budgets, OTB plan cells, brand
 * coverage + lead-time overrides) is STORED under brandKey(label): trimmed and
 * upper-cased. A feed may carry brand labels in mixed case
 * ("Brand B", "Brand O and E"), so a read must never index those maps by
 * the raw row label: exact indexing misses every mixed-case brand. Every
 * brand-keyed READ goes through
 * brandLookup; class keys stay exact (they were never upper-cased).
 */

/** The canonical key for a brand label or 3-char SKU code: trimmed, upper-cased. */
export function brandKey(label: string): string {
  return label.trim().toUpperCase();
}

/** Own-property read, so a brand named like an Object.prototype member never resolves to it. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Read a brand-keyed map case-insensitively: the canonical key every write
 * stores, else an exact key (a row written before the normalisation existed).
 */
export function brandLookup<T>(map: Readonly<Record<string, T>>, label: string): T | undefined {
  return own(map, brandKey(label)) ?? own(map, label);
}

/** What the brand-keyed write tools (budget, OTB plan) say about how their stored key matches. */
export const BRAND_KEY_NOTE =
  'brand keys are stored upper-cased and match the feed brand label case-insensitively ("BRAND B" applies to the "Brand B" row)';

/** The same for brand override maps in settings, which also accept the 3-char SKU code. */
export const BRAND_OVERRIDE_KEY_NOTE = `${BRAND_KEY_NOTE}; an override key may also be the SKU's 3-char code (e.g. "BBB"), and the label beats the code`;

/**
 * Re-key brand-dimension rows stored under brandKey onto the label the feed
 * rows carry, so an OTB plan nets against the brand's real stock instead of
 * surfacing as a second, phantom upper-cased key. A row for a brand absent
 * from the feed keeps its stored key.
 */
export function onFeedLabels<T extends { key: string }>(rows: T[], feedLabels: Iterable<string>): T[] {
  const labelByKey = new Map<string, string>();
  for (const label of feedLabels) {
    const k = brandKey(label);
    if (!labelByKey.has(k)) labelByKey.set(k, label);
  }
  return rows.map((r) => {
    const label = labelByKey.get(brandKey(r.key));
    return label !== undefined && label !== r.key ? { ...r, key: label } : r;
  });
}

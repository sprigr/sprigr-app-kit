/**
 * Filter-string assembly for the Sprigr search wire contract.
 *
 * Emits the engine-native flat-CNF grammar (verified against the engine's
 * parse_query_filters in sprigr-search crates/search-core/src/filter.rs):
 *
 *   expr   := clause ((" AND " | ",") clause)*
 *   clause := term (" OR " term)*
 *   term   := attribute ":" value        (split on the FIRST colon, unquoted)
 *
 * Rules the emitter follows:
 * - Values are UNQUOTED by default: the engine compares the raw substring
 *   after the first colon, so quoted values match nothing on today's engine.
 * - OR groups are flat with NO parentheses: `a:v1 OR a:v2` as its own
 *   comma-joined conjunct. OR binds tighter than the comma/AND conjunction in
 *   the engine, so flat is correct; parens are never emitted (the engine
 *   would silently drop a `(a`-prefixed attribute).
 * - Numeric ranges emit `attr:MIN TO MAX`. Today's engine has no range
 *   support (the term no-ops or zero-matches); ranges start working when the
 *   in-flight engine change adding range + quote/paren tolerance deploys.
 * - A value containing a separator substring (" OR ", " AND ", or a comma)
 *   is wrapped in double quotes as a forward-compat escape hatch. Such
 *   values are rare, and the quoted form only matches once the engine
 *   tolerance change deploys.
 *
 * Silent-drop warning: the engine keeps only terms whose attribute is
 * declared in the index's `attributes_for_faceting`; any other term is
 * SILENTLY dropped (the clause vanishes, results widen). This is the number
 * one silent failure when a filter "does nothing".
 */

/** Escape embedded double quotes so a value survives inside `attr:"..."`. */
export function escapeFilterValue(v: string): string {
  return v.replace(/"/g, '\\"');
}

/**
 * True when a raw value would be broken apart by the engine's separator
 * splits (" OR ", " AND ", or the comma) and so needs the quoted form.
 */
function needsQuoting(v: string): boolean {
  return v.includes(',') || v.includes(' OR ') || v.includes(' AND ');
}

/**
 * Format one attr:value term in engine-native form: unquoted by default;
 * quoted only when the value contains a separator substring (rare, and the
 * quoted form only matches after the engine tolerance change deploys).
 */
function formatTerm(attr: string, value: string): string {
  return needsQuoting(value) ? `${attr}:"${escapeFilterValue(value)}"` : `${attr}:${value}`;
}

export type RangeState = { min: number | null; max: number | null };

/**
 * Build the comma-joined (AND) filter expression from selected facet values
 * and numeric ranges. One clause per attr: a single value becomes
 * `attr:value`; multiple values become a flat OR clause
 * `attr:v1 OR attr:v2` (no parentheses); a range becomes `attr:MIN TO MAX`.
 *
 * @param selected  attr -> set of selected string values (order preserved)
 * @param ranges    attr -> {min, max}; a term is emitted when either bound is set
 * @param rangeCeiling  the value substituted for an unbounded max (default 1e8)
 */
export function buildFilterString(
  selected: Record<string, Set<string>>,
  ranges: Record<string, RangeState> = {},
  rangeCeiling = 100000000,
): string {
  const parts: string[] = [];
  for (const attr of Object.keys(selected)) {
    const vals = [...selected[attr]!];
    if (vals.length > 0) {
      parts.push(vals.map((v) => formatTerm(attr, v)).join(' OR '));
    }
  }
  for (const attr of Object.keys(ranges)) {
    const { min, max } = ranges[attr]!;
    if (min != null || max != null) {
      parts.push(`${attr}:${min ?? 0} TO ${max ?? rangeCeiling}`);
    }
  }
  return parts.join(',');
}

/**
 * AND a fixed base filter with the user-assembled filter expression.
 *
 * When the user filter is empty the base filter stands alone; otherwise the
 * two are comma-joined (comma = AND in the engine syntax). An empty or
 * whitespace-only base filter is ignored.
 *
 * Interaction note: when the user selects values of a facet the base filter
 * also constrains, the two are plain-ANDed. A selection inside the base set
 * narrows results as expected; a selection outside it yields zero results.
 * No merging or de-duplication is attempted: plain AND is correct and
 * predictable.
 */
export function combineFilters(baseFilter: string | undefined, userFilters: string): string {
  const base = baseFilter?.trim() ?? '';
  if (!base) return userFilters;
  if (!userFilters) return base;
  return `${base},${userFilters}`;
}

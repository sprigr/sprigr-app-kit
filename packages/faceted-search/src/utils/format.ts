/**
 * Value formatting + facet sorting helpers.
 */
import type { CardPrimary, FacetConfig } from '../types';

/** Format a primary value (money/number/text) per the card config. */
export function formatPrimary(value: unknown, cfg: CardPrimary): string {
  if (value == null || value === '') return '';
  if (cfg.format === 'text') return String(value);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const locale = cfg.locale;
  if (cfg.format === 'money') {
    if (cfg.currency) {
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: cfg.currency,
          maximumFractionDigits: 0,
        }).format(n);
      } catch {
        // Fall through to the plain $ form on an invalid currency code.
      }
    }
    return '$' + n.toLocaleString(locale);
  }
  // 'number' (or unspecified numeric)
  return n.toLocaleString(locale);
}

/** Capitalize the first letter of each word. */
export function capitalizeWords(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Display label for a facet value: valueLabels override wins, then numeric
 * pluralization ("3 beds"), then a passthrough of the raw value.
 */
export function facetValueLabel(facet: FacetConfig, value: string): string {
  if (facet.valueLabels && value in facet.valueLabels) return facet.valueLabels[value]!;
  if (facet.numeric) {
    const suffix = facet.suffix ?? '';
    if (!suffix) return value;
    return `${value} ${suffix}${Number(value) === 1 ? '' : 's'}`;
  }
  return value;
}

/**
 * Order a facet's values for display:
 * - numeric facets: ascending by numeric value
 * - categorical facets: by count descending, ties broken alphabetically
 *
 * Selected-but-absent values (selected by the user but with a zero count in
 * the current result) are appended so the checkbox stays visible.
 */
export function sortFacetKeys(
  facet: FacetConfig,
  counts: Record<string, number>,
  selected: Set<string>,
): string[] {
  const keys = Object.keys(counts);
  keys.sort((a, b) =>
    facet.numeric ? Number(a) - Number(b) : (counts[b]! - counts[a]!) || a.localeCompare(b),
  );
  for (const v of selected) if (!keys.includes(v)) keys.push(v);
  return keys;
}

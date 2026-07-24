import { describe, expect, it } from 'vitest';
import { facetValueLabel, formatPrimary, sortFacetKeys } from '../src/utils/format';
import type { FacetConfig } from '../src/types';

describe('formatPrimary', () => {
  it('formats money in en-AU with a leading $', () => {
    expect(formatPrimary(750000, { attr: 'price', format: 'money', locale: 'en-AU' })).toBe(
      '$750,000',
    );
  });
  it('formats money with an explicit currency code', () => {
    const out = formatPrimary(1234, { attr: 'price', format: 'money', locale: 'en-US', currency: 'USD' });
    expect(out).toContain('1,234');
    expect(out).toMatch(/\$|USD/);
  });
  it('formats plain numbers', () => {
    expect(formatPrimary(1234567, { attr: 'n', format: 'number', locale: 'en-US' })).toBe('1,234,567');
  });
  it('passes text through', () => {
    expect(formatPrimary('Contact agent', { attr: 't', format: 'text' })).toBe('Contact agent');
  });
  it('returns empty for null/undefined', () => {
    expect(formatPrimary(null, { attr: 'x', format: 'money' })).toBe('');
    expect(formatPrimary(undefined, { attr: 'x' })).toBe('');
  });
});

describe('facetValueLabel', () => {
  const numeric: FacetConfig = { attr: 'bedrooms', label: 'Beds', numeric: true, suffix: 'bed' };
  it('pluralizes numeric suffixes', () => {
    expect(facetValueLabel(numeric, '1')).toBe('1 bed');
    expect(facetValueLabel(numeric, '3')).toBe('3 beds');
  });
  it('prefers valueLabels overrides', () => {
    const f: FacetConfig = { attr: 'status', label: 'Status', valueLabels: { active: 'For Sale' } };
    expect(facetValueLabel(f, 'active')).toBe('For Sale');
    expect(facetValueLabel(f, 'other')).toBe('other');
  });
});

describe('sortFacetKeys', () => {
  it('sorts numeric facets ascending by value', () => {
    const f: FacetConfig = { attr: 'bedrooms', label: 'Beds', numeric: true };
    const keys = sortFacetKeys(f, { '3': 5, '1': 2, '10': 1, '2': 9 }, new Set());
    expect(keys).toEqual(['1', '2', '3', '10']);
  });
  it('sorts categorical facets by count desc, ties alphabetical', () => {
    const f: FacetConfig = { attr: 'type', label: 'Type' };
    const keys = sortFacetKeys(f, { house: 3, unit: 3, land: 10 }, new Set());
    expect(keys).toEqual(['land', 'house', 'unit']);
  });
  it('appends selected-but-absent values', () => {
    const f: FacetConfig = { attr: 'type', label: 'Type' };
    const keys = sortFacetKeys(f, { house: 3 }, new Set(['unit']));
    expect(keys).toEqual(['house', 'unit']);
  });
});

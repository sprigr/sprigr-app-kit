import { describe, it, expect } from 'vitest';
import { brandKey, brandLookup, onRowLabels } from '../src/brand-key';

describe('brand-key', () => {
  it('brandKey trims and upper-cases', () => {
    expect(brandKey('  Brand P and Q ')).toBe('BRAND P AND Q');
    expect(brandKey('brand f')).toBe('BRAND F');
  });

  it('brandLookup reads the canonical key, then an exact raw-label key, never the prototype', () => {
    expect(brandLookup({ 'BRAND B': 500 }, 'Brand B')).toBe(500);
    expect(brandLookup({ 'Brand B': 7 }, 'Brand B')).toBe(7);
    expect(brandLookup({ 'BRAND F': 1 }, 'Brand B')).toBeUndefined();
    expect(brandLookup({} as Record<string, number>, 'constructor')).toBeUndefined();
  });

  it('onRowLabels lands stored keys on the row label and leaves unknown brands alone', () => {
    const rows = [
      { key: 'BRAND B', month: '2026-10' },
      { key: 'GHOST', month: '2026-10' },
    ];
    expect(onRowLabels(rows, ['Brand B', 'Brand F'])).toEqual([
      { key: 'Brand B', month: '2026-10' },
      { key: 'GHOST', month: '2026-10' },
    ]);
  });

  it('onRowLabels keeps the first spelling when two row labels share a key', () => {
    expect(onRowLabels([{ key: 'BRAND B' }], ['brand b', 'Brand B'])).toEqual([{ key: 'brand b' }]);
  });
});

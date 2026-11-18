import { describe, it, expect } from 'vitest';
import { brandKey, brandLookup, onFeedLabels } from '../src/brand-key';

describe('brand-key', () => {
  it('brandKey trims and upper-cases', () => {
    expect(brandKey('  Brand P and Q ')).toBe('BRAND P AND Q');
    expect(brandKey('fff')).toBe('FFF');
  });

  it('brandLookup reads the canonical key, then an exact legacy key, never the prototype', () => {
    expect(brandLookup({ 'BRAND B': 500 }, 'Brand B')).toBe(500);
    expect(brandLookup({ 'Brand B': 7 }, 'Brand B')).toBe(7);
    expect(brandLookup({ FFF: 1 }, 'Brand B')).toBeUndefined();
    expect(brandLookup({} as Record<string, number>, 'constructor')).toBeUndefined();
  });

  it('onFeedLabels lands stored keys on the feed label and leaves unknown brands alone', () => {
    const rows = [
      { key: 'BRAND B', month: '2026-10' },
      { key: 'GHOST', month: '2026-10' },
    ];
    expect(onFeedLabels(rows, ['Brand B', 'FFF'])).toEqual([
      { key: 'Brand B', month: '2026-10' },
      { key: 'GHOST', month: '2026-10' },
    ]);
  });
});

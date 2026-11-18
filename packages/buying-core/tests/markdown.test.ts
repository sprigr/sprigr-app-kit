import { describe, it, expect } from 'vitest';
import { markdownCandidates, type MarkdownInput } from '../src/markdown';

const row = (
  sku: string,
  o: {
    isActive?: boolean;
    qty?: number;
    cost?: number | null;
    rrp?: number;
    age?: number | null;
    cover?: number | null;
    dead?: boolean;
    basis?: 'forward' | 'trailing';
  } = {},
): MarkdownInput['rows'][number] => ({
  sku,
  name: `${sku} name`,
  ...(o.isActive === undefined ? {} : { is_active: o.isActive }),
  brand: 'Brand B',
  stats: {
    qty: o.qty ?? 10,
    unit_cost: o.cost === undefined ? 10 : o.cost,
    rrp: o.rrp ?? 40,
    age_of_oldest_item_days: o.age ?? null,
    class_1: 'CAT_A',
  },
  derived: {
    is_dead: o.dead ?? false,
    coverage_days: o.cover ?? 30,
    forward_coverage_days: o.cover ?? null,
    basis: o.basis ?? 'trailing',
  },
});

describe('markdownCandidates', () => {
  it('ranks by value at stake and picks depth by the worst condition', () => {
    const out = markdownCandidates({
      rows: [
        row('SKU-1', { dead: true, qty: 5, cost: 100 }), // dead: 50%, value 500
        row('SKU-2', { age: 220, qty: 20, cost: 10 }), // over 180: 40%, value 200
        row('SKU-3', { age: 120, qty: 10, cost: 8 }), // 90-180: 20%, value 80
        row('SKU-4', { age: 30, cover: 40 }), // healthy: excluded
        row('SKU-5', { dead: true, isActive: false }), // not active: excluded
        row('SKU-6', { dead: true, qty: 0 }), // no stock: excluded
      ],
    });
    expect(out.map((c) => c.sku)).toEqual(['SKU-1', 'SKU-2', 'SKU-3']);
    expect(out[0]).toMatchObject({ suggested_depth_pct: 50, value_at_stake: 500, suggested_price: 20 });
    expect(out[1]).toMatchObject({ suggested_depth_pct: 40, suggested_price: 24 });
    expect(out[2]).toMatchObject({ suggested_depth_pct: 20, margin_floor: 8 });
    expect(out[0]!.reasons.some((r) => r.code === 'DEAD_STOCK')).toBe(true);
    expect(out[0]!.brand).toBe('Brand B');
  });

  it('flags heavy overcover and uses forward cover when the basis is forward', () => {
    const out = markdownCandidates({
      rows: [row('SKU-1', { cover: 400, basis: 'forward', age: 20 })],
    });
    expect(out).toHaveLength(1);
    // overcover must use OVERCOVER, not BELOW_TARGET_COVER (that
    // code means a cover shortfall - the opposite of this excess-stock case).
    expect(out[0]!.reasons.some((r) => r.code === 'OVERCOVER')).toBe(true);
    expect(out[0]!.reasons.some((r) => r.code === 'BELOW_TARGET_COVER')).toBe(false);
    expect(out[0]!.suggested_depth_pct).toBe(20);
  });

  it('treats a row as active unless is_active is false', () => {
    const out = markdownCandidates({
      rows: [
        row('SKU-1', { dead: true }), // is_active absent
        row('SKU-2', { dead: true, isActive: true }),
        row('SKU-3', { dead: true, isActive: false }),
      ],
    });
    expect(out.map((c) => c.sku).sort()).toEqual(['SKU-1', 'SKU-2']);
  });

  it('moves the aged buckets with aged_days and leaves them at 90 / 180 by default', () => {
    const rows = [
      row('SKU-1', { age: 100, qty: 10, cost: 30 }), // value 300
      row('SKU-2', { age: 70, qty: 10, cost: 20 }), // value 200
      row('SKU-3', { age: 50, qty: 10, cost: 10 }), // value 100
    ];
    const codes = (out: ReturnType<typeof markdownCandidates>) => out.map((c) => `${c.sku}:${c.reasons[0]!.code}:${c.suggested_depth_pct}`);
    // Default [90, 180]: only the 100-day row is aged, in the first bucket.
    expect(codes(markdownCandidates({ rows }))).toEqual(['SKU-1:AGED_FIRST:20']);
    // [60, 90]: 100d is past the second threshold, 70d past the first, 50d neither.
    expect(codes(markdownCandidates({ rows, aged_days: [60, 90] }))).toEqual(['SKU-1:AGED_SECOND:40', 'SKU-2:AGED_FIRST:20']);
  });

  it('prices each condition from markdown_depths, keeping the default for a key left out', () => {
    const rows = [
      row('SKU-1', { dead: true, qty: 5, cost: 100 }), // dead
      row('SKU-2', { age: 220, qty: 20, cost: 10 }), // second aged bucket
      row('SKU-3', { age: 120, qty: 10, cost: 8 }), // first aged bucket
    ];
    const out = markdownCandidates({ rows, markdown_depths: { dead: 0.6, default: 0.1 } });
    // rrp 40: 60% off = 16, 40% off (default kept) = 24, 10% off = 36.
    expect(out.map((c) => [c.sku, c.suggested_depth_pct, c.suggested_price])).toEqual([
      ['SKU-1', 60, 16],
      ['SKU-2', 40, 24],
      ['SKU-3', 10, 36],
    ]);
  });
});

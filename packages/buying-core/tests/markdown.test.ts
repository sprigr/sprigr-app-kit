import { describe, it, expect } from 'vitest';
import { markdownCandidates, type MarkdownInput } from '../src/markdown';

const row = (
  sku: string,
  o: {
    status?: string;
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
  status: o.status ?? 'active',
  brand: sku.slice(0, 3),
  stats: {
    qty: o.qty ?? 10,
    unit_cost: o.cost === undefined ? 10 : o.cost,
    rrp: o.rrp ?? 40,
    age_of_oldest_item_days: o.age ?? null,
    class_1: 'Accessories',
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
        row('DEAD1', { dead: true, qty: 5, cost: 100 }), // dead → 50%, value 500
        row('AGE180', { age: 220, qty: 20, cost: 10 }), // >180 → 40%, value 200
        row('AGE90', { age: 120, qty: 10, cost: 8 }), // 90-180 → 20%, value 80
        row('FRESH', { age: 30, cover: 40 }), // healthy → excluded
        row('IGNORED', { dead: true, status: 'ignore' }), // non-active excluded
        row('EMPTY', { dead: true, qty: 0 }), // no stock → excluded
      ],
    });
    expect(out.map((c) => c.sku)).toEqual(['DEAD1', 'AGE180', 'AGE90']);
    expect(out[0]).toMatchObject({ suggested_depth_pct: 50, value_at_stake: 500, suggested_price: 20 });
    expect(out[1]).toMatchObject({ suggested_depth_pct: 40, suggested_price: 24 });
    expect(out[2]).toMatchObject({ suggested_depth_pct: 20, margin_floor: 8 });
    expect(out[0]!.reasons.some((r) => r.code === 'DEAD_STOCK')).toBe(true);
  });

  it('flags heavy overcover and uses forward cover when the basis is forward', () => {
    const out = markdownCandidates({
      rows: [row('OVER1', { cover: 400, basis: 'forward', age: 20 })],
    });
    expect(out).toHaveLength(1);
    // overcover must use OVERCOVER, not BELOW_TARGET_COVER (that
    // code means a cover shortfall - the opposite of this excess-stock case).
    expect(out[0]!.reasons.some((r) => r.code === 'OVERCOVER')).toBe(true);
    expect(out[0]!.reasons.some((r) => r.code === 'BELOW_TARGET_COVER')).toBe(false);
    expect(out[0]!.suggested_depth_pct).toBe(20);
  });
});

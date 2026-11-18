import { describe, it, expect } from 'vitest';
import { seasonalBuy, normalQuantile, monthlySigma } from '../src/newsvendor';

describe('normalQuantile', () => {
  it('matches known standard-normal quantiles', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 3);
    expect(normalQuantile(0.9)).toBeCloseTo(1.281552, 3);
    expect(normalQuantile(0.1)).toBeCloseTo(-1.281552, 3);
  });
});

describe('monthlySigma', () => {
  it('is the population std-dev, 0 for under two points', () => {
    expect(monthlySigma([10, 10, 10])).toBe(0);
    expect(monthlySigma([2, 4, 6, 8])).toBeCloseTo(Math.sqrt(5), 6);
    expect(monthlySigma([5])).toBe(0);
  });
});

describe('seasonalBuy', () => {
  it('orders above the mean when margin dwarfs the overage cost (high fractile)', () => {
    // price 800, cost 400, salvage 30% → Cu 400, Co 280. fractile 0.588.
    const r = seasonalBuy({
      sku: 'BRD-1',
      price: 800,
      unit_cost: 400,
      salvage_rate: 0.3,
      season_demand_mean: 40,
      monthly_sigma: 4,
      season_months: 4,
      already_committed: 5,
    })!;
    expect(r.critical_fractile).toBeCloseTo(0.588, 2);
    expect(r.z).toBeGreaterThan(0); // fractile > 0.5 → buy above the mean
    // sigma scaled by sqrt(4)=2 → 8; Q* = 40 + z*8 > 40; buy = Q* - 5.
    expect(r.season_sigma).toBe(8);
    expect(r.q_star).toBeGreaterThan(40);
    expect(r.suggested_buy).toBe(Math.max(0, r.q_star - 5));
    expect(r.assumptions).toContain('over 4mo');
  });

  it('returns null on degenerate economics', () => {
    expect(
      seasonalBuy({ sku: 'X', price: 100, unit_cost: 120, salvage_rate: 0.3, season_demand_mean: 10, monthly_sigma: 2, season_months: 4, already_committed: 0 }),
    ).toBeNull(); // negative margin
    expect(
      seasonalBuy({ sku: 'X', price: 100, unit_cost: 40, salvage_rate: 0.3, season_demand_mean: 0, monthly_sigma: 2, season_months: 4, already_committed: 0 }),
    ).toBeNull(); // no season demand
  });
});

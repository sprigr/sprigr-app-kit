import { describe, it, expect } from 'vitest';
import { addMonths, comparisonWindow, monthsRange, resolvePeriod, type PeriodCalendar } from '../src';
import { reasonOf } from './fixture';

const cal: PeriodCalendar = {
  fiscal_year_start_month: 7,
  week_start: 'monday',
  custom: [{ key: 'opening_week', label: 'Opening week', from: '2026-03-02', to: '2026-03-08' }],
};

describe('resolvePeriod presets', () => {
  it('rolling 12 ends with the current month', () => {
    const p = resolvePeriod({ preset: 'rolling_12' }, cal, '2026-11-21');
    expect(p.window).toEqual({ from: '2025-12-01', to: '2026-12-01' });
    expect(p.buckets).toHaveLength(12);
    expect(p.buckets[0]).toMatchObject({ key: 'p1', label: 'Dec 2025', from: '2025-12-01', to: '2026-01-01', days: 31 });
    expect(p.buckets[11]).toMatchObject({ key: 'p12', label: 'Nov 2026' });
  });

  it('financial year to date restarts on the first day of the financial year', () => {
    expect(resolvePeriod({ preset: 'financial_ytd' }, cal, '2026-06-30').window).toEqual({ from: '2025-07-01', to: '2026-07-01' });
    expect(resolvePeriod({ preset: 'financial_ytd' }, cal, '2026-07-01').window).toEqual({ from: '2026-07-01', to: '2026-08-01' });
  });

  it('calendar year to date ignores the financial year', () => {
    expect(resolvePeriod({ preset: 'calendar_ytd' }, cal, '2026-11-21').window).toEqual({ from: '2026-01-01', to: '2026-12-01' });
  });

  it('last 3 months and previous month cross a year end', () => {
    expect(resolvePeriod({ preset: 'last_3_months' }, cal, '2026-01-15').window).toEqual({ from: '2025-10-01', to: '2026-01-01' });
    expect(resolvePeriod({ preset: 'previous_month' }, cal, '2026-01-15').window).toEqual({ from: '2025-12-01', to: '2026-01-01' });
    expect(resolvePeriod({ preset: 'rolling_3' }, cal, '2026-01-15').window).toEqual({ from: '2025-11-01', to: '2026-02-01' });
  });

  it('month to date on a leap day covers 29 days', () => {
    const p = resolvePeriod({ preset: 'month_to_date' }, cal, '2024-02-29');
    expect(p.window).toEqual({ from: '2024-02-01', to: '2024-03-01' });
    expect(p.buckets[0]?.days).toBe(29);
  });

  it('period to date stops the window at today', () => {
    const p = resolvePeriod({ preset: 'rolling_12' }, cal, '2026-11-21', { periodToDate: true });
    expect(p.window.to).toBe('2026-11-22');
    expect(p.buckets[11]?.days).toBe(21);
  });
});

describe('resolvePeriod custom and named periods', () => {
  it('treats the end date as the last day', () => {
    expect(resolvePeriod({ named: 'opening_week' }, cal, '2026-11-21').window).toEqual({ from: '2026-03-02', to: '2026-03-09' });
  });

  it('cuts weeks on the calendar week start', () => {
    const monday = resolvePeriod({ custom: { from: '2026-11-18', to: '2026-11-30' }, grain: 'week' }, cal, '2026-11-21');
    expect(monday.buckets.map((b) => [b.label, b.from, b.days])).toEqual([
      ['w/c 2026-11-16', '2026-11-18', 5],
      ['w/c 2026-11-23', '2026-11-23', 7],
      ['w/c 2026-11-30', '2026-11-30', 1],
    ]);
    const sunday = resolvePeriod({ custom: { from: '2026-11-18', to: '2026-11-30' }, grain: 'week' }, { ...cal, week_start: 'sunday' }, '2026-11-21');
    expect(sunday.buckets[1]?.from).toBe('2026-11-22');
  });

  it('names a financial year for the year it ends in', () => {
    const p = resolvePeriod({ custom: { from: '2025-01-01', to: '2026-12-31' }, grain: 'fiscal_year' }, cal, '2026-11-21');
    expect(p.buckets.map((b) => [b.label, b.from])).toEqual([['FY2025', '2025-01-01'], ['FY2026', '2025-07-01'], ['FY2027', '2026-07-01']]);
  });

  it.each([
    [{ named: 'nope' }, '2026-11-21', 'unknown_period'],
    [{ custom: { from: '2026-02-01', to: '2026-01-01' } }, '2026-11-21', 'period_range_inverted'],
    [{ custom: { from: '2026-01-01', to: '2026-12-31' }, grain: 'day' as const }, '2026-11-21', 'too_many_periods'],
    [{ preset: 'rolling_12' as const }, '2026-02-30', 'bad_date'],
  ])('refuses %j', (spec, today, reason) => {
    expect(reasonOf(() => resolvePeriod(spec, cal, today))).toBe(reason);
  });
});

describe('date helpers', () => {
  it('keeps month ends when adding months', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2026-01-15', -3)).toBe('2025-10-15');
  });

  it('compares with the same dates a year earlier, or the period just before', () => {
    expect(comparisonWindow({ from: '2024-02-01', to: '2024-03-01' }, 'previous_year')).toEqual({ from: '2023-02-01', to: '2023-03-01' });
    expect(comparisonWindow({ from: '2026-11-01', to: '2026-12-01' }, 'previous_period')).toEqual({ from: '2026-10-01', to: '2026-11-01' });
    expect(comparisonWindow({ from: '2026-11-01', to: '2026-11-22' }, 'previous_period')).toEqual({ from: '2026-10-11', to: '2026-11-01' });
  });

  it('gives the inclusive month range a window touches', () => {
    expect(monthsRange({ from: '2025-12-01', to: '2026-12-01' })).toEqual({ from: '2025-12', to: '2026-11' });
  });
});

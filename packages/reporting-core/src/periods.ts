/**
 * The period engine. Pure date maths over `YYYY-MM-DD` strings: no clock, no
 * time zone. The caller passes "today" in the tenant's own zone.
 *
 * A window is half-open: `from` is the first day in it, `to` is the first day
 * after it. That is the form the SQL needs (`date >= from AND date < to`).
 */
import { ReportingError } from './reasons';

export type WeekStart = 'monday' | 'sunday';
export const PERIOD_GRAINS = ['day', 'week', 'month', 'year', 'fiscal_year'] as const;
export type PeriodGrain = (typeof PERIOD_GRAINS)[number];

export const PERIOD_PRESETS = [
  'calendar_ytd', 'financial_ytd', 'current_month', 'month_to_date',
  'previous_month', 'last_3_months', 'rolling_3', 'rolling_12',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface NamedPeriod { key: string; label: string; from: string; to: string }

export interface PeriodCalendar {
  /** 1 to 12. 7 is a July to June financial year. */
  fiscal_year_start_month: number;
  week_start: WeekStart;
  /** A tenant's own named periods. `to` is the last day, inclusive. */
  custom: NamedPeriod[];
}

/** What a view stores. In `custom`, `to` is the last day, inclusive. */
export type PeriodSpec =
  | { preset: PeriodPreset; grain?: PeriodGrain }
  | { custom: { from: string; to: string }; grain?: PeriodGrain }
  | { named: string; grain?: PeriodGrain };

export interface PeriodWindow { from: string; to: string }
export interface PeriodBucket extends PeriodWindow { key: string; label: string; days: number }
export interface ResolvedPeriod { window: PeriodWindow; grain: PeriodGrain; buckets: PeriodBucket[] }

export const MAX_PERIOD_BUCKETS = 120;

const ISO_RX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

interface Ymd { y: number; m: number; d: number }

function parts(iso: string): Ymd | null {
  const match = typeof iso === 'string' ? ISO_RX.exec(iso) : null;
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function need(iso: string): Ymd {
  const p = parts(iso);
  if (!p) throw new ReportingError('bad_date', `"${String(iso).slice(0, 20)}" is not a real YYYY-MM-DD date`);
  return p;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function fmt(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function utc(p: Ymd): number {
  return Date.UTC(p.y, p.m - 1, p.d);
}

function fromUtc(ms: number): string {
  const t = new Date(ms);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && parts(value) !== null;
}

export function addDays(iso: string, n: number): string {
  return fromUtc(utc(need(iso)) + n * DAY_MS);
}

/** Month arithmetic that keeps the day where it can: 31 Jan plus one month is the last day of Feb. */
export function addMonths(iso: string, n: number): string {
  const p = need(iso);
  const index = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return fmt(y, m, Math.min(p.d, daysInMonth(y, m)));
}

export function startOfMonth(iso: string): string {
  const p = need(iso);
  return fmt(p.y, p.m, 1);
}

/** Days from `from` up to but not including `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(need(to)) - utc(need(from))) / DAY_MS);
}

/** First day of the financial year that holds `iso`. */
export function fiscalYearStart(iso: string, startMonth: number): string {
  const p = need(iso);
  return fmt(p.m >= startMonth ? p.y : p.y - 1, startMonth, 1);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function checkCalendar(cal: PeriodCalendar): void {
  if (!Number.isInteger(cal.fiscal_year_start_month) || cal.fiscal_year_start_month < 1 || cal.fiscal_year_start_month > 12) {
    throw new ReportingError('unknown_period', 'fiscal_year_start_month must be 1 to 12');
  }
}

function presetWindow(preset: PeriodPreset, cal: PeriodCalendar, today: string): PeriodWindow {
  const month = startOfMonth(today);
  const nextMonth = addMonths(month, 1);
  switch (preset) {
    case 'calendar_ytd': return { from: fmt(need(today).y, 1, 1), to: nextMonth };
    case 'financial_ytd': return { from: fiscalYearStart(today, cal.fiscal_year_start_month), to: nextMonth };
    case 'current_month': return { from: month, to: nextMonth };
    case 'month_to_date': return { from: month, to: addDays(today, 1) };
    case 'previous_month': return { from: addMonths(month, -1), to: month };
    case 'last_3_months': return { from: addMonths(month, -3), to: month };
    case 'rolling_3': return { from: addMonths(month, -2), to: nextMonth };
    case 'rolling_12': return { from: addMonths(month, -11), to: nextMonth };
  }
}

function inclusiveWindow(from: string, to: string): PeriodWindow {
  need(from);
  need(to);
  if (to < from) throw new ReportingError('period_range_inverted', `the period ends (${to}) before it starts (${from})`);
  return { from, to: addDays(to, 1) };
}

function nextBoundary(iso: string, grain: PeriodGrain, cal: PeriodCalendar): string {
  const p = need(iso);
  switch (grain) {
    case 'day': return addDays(iso, 1);
    case 'week': return addDays(iso, 7 - daysIntoWeek(iso, cal.week_start));
    case 'month': return addMonths(fmt(p.y, p.m, 1), 1);
    case 'year': return fmt(p.y + 1, 1, 1);
    case 'fiscal_year': return addMonths(fiscalYearStart(iso, cal.fiscal_year_start_month), 12);
  }
}

function daysIntoWeek(iso: string, weekStart: WeekStart): number {
  const weekday = new Date(utc(need(iso))).getUTCDay();
  return (weekday - (weekStart === 'monday' ? 1 : 0) + 7) % 7;
}

function labelFor(iso: string, grain: PeriodGrain, cal: PeriodCalendar): string {
  const p = need(iso);
  switch (grain) {
    case 'day': return iso;
    case 'week': return `w/c ${addDays(iso, -daysIntoWeek(iso, cal.week_start))}`;
    case 'month': return `${MONTH_NAMES[p.m - 1] ?? ''} ${p.y}`;
    case 'year': return String(p.y);
    case 'fiscal_year': {
      const start = need(fiscalYearStart(iso, cal.fiscal_year_start_month));
      // A financial year that does not start in January is named for the year it ends in.
      return cal.fiscal_year_start_month === 1 ? String(start.y) : `FY${start.y + 1}`;
    }
  }
}

/** Cut a window into period columns. The first and last may be part periods. */
export function splitWindow(window: PeriodWindow, grain: PeriodGrain, cal: PeriodCalendar): PeriodBucket[] {
  if (!(PERIOD_GRAINS as readonly string[]).includes(grain)) throw new ReportingError('bad_grain', `"${String(grain)}" is not a period grain`);
  const out: PeriodBucket[] = [];
  let cursor = window.from;
  while (cursor < window.to) {
    const next = minDate(nextBoundary(cursor, grain, cal), window.to);
    if (out.length >= MAX_PERIOD_BUCKETS) {
      throw new ReportingError('too_many_periods', `more than ${MAX_PERIOD_BUCKETS} ${grain} columns; pick a coarser grain or a shorter period`);
    }
    out.push({ key: `p${out.length + 1}`, label: labelFor(cursor, grain, cal), from: cursor, to: next, days: daysBetween(cursor, next) });
    cursor = next;
  }
  return out;
}

export interface ResolvePeriodOptions {
  /** Stop the window at today, so a part period compares with the same part of an earlier one. */
  periodToDate?: boolean;
}

export function resolvePeriod(spec: PeriodSpec, cal: PeriodCalendar, today: string, options: ResolvePeriodOptions = {}): ResolvedPeriod {
  need(today);
  checkCalendar(cal);
  let window: PeriodWindow;
  if ('preset' in spec) {
    if (!(PERIOD_PRESETS as readonly string[]).includes(spec.preset)) throw new ReportingError('unknown_period', `"${String(spec.preset)}" is not a preset`);
    window = presetWindow(spec.preset, cal, today);
  } else if ('custom' in spec) {
    window = inclusiveWindow(spec.custom?.from, spec.custom?.to);
  } else if ('named' in spec) {
    const named = cal.custom.find((p) => p.key === spec.named);
    if (!named) throw new ReportingError('unknown_period', `no named period "${String(spec.named).slice(0, 60)}"`);
    window = inclusiveWindow(named.from, named.to);
  } else {
    throw new ReportingError('unknown_period', 'a period needs a preset, a custom range or a named period');
  }
  if (options.periodToDate) {
    const stop = addDays(today, 1);
    if (window.from < stop && stop < window.to) window = { from: window.from, to: stop };
  }
  const grain = spec.grain ?? 'month';
  return { window, grain, buckets: splitWindow(window, grain, cal) };
}

/** Whole months between two first-of-month dates, or null when either is mid-month. */
function wholeMonths(window: PeriodWindow): number | null {
  const a = need(window.from);
  const b = need(window.to);
  if (a.d !== 1 || b.d !== 1) return null;
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/** The window a variance compares against: the same dates a year earlier, or the period just before. */
export function comparisonWindow(window: PeriodWindow, kind: 'previous_year' | 'previous_period'): PeriodWindow {
  if (kind === 'previous_year') return { from: addMonths(window.from, -12), to: addMonths(window.to, -12) };
  const months = wholeMonths(window);
  if (months !== null) return { from: addMonths(window.from, -months), to: window.from };
  return { from: addDays(window.from, -daysBetween(window.from, window.to)), to: window.from };
}

/** The inclusive `YYYY-MM` range a window touches, for the query route's `months` argument. */
export function monthsRange(window: PeriodWindow): { from: string; to: string } {
  return { from: window.from.slice(0, 7), to: addDays(window.to, -1).slice(0, 7) };
}

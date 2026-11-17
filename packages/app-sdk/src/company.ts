/**
 * The install's company, as the platform binds it (sprigr-team#11006).
 *
 * `COMPANY_TIMEZONE` is a plain_text binding stamped at upload
 * (sprigr-team#11038): the company's IANA zone, so an app can compute the
 * tenant's "today" or a local cut-off without guessing. The platform binds it
 * only when the company has a valid zone, and never a default, so an install
 * whose company has none simply has no binding. A value written before a
 * zone change stays until the install's next build.
 */

/** The env slice this module reads. Optional: older installs lack it. */
export interface CompanyTimezoneEnv {
  COMPANY_TIMEZONE?: string;
}

/**
 * The company's IANA zone, or `undefined` when there is none.
 *
 * Returns the bound value (trimmed) only when `Intl` accepts it as a time
 * zone, so the result can be handed straight to `Intl.DateTimeFormat`. Never
 * throws and never invents a zone: `undefined` means "the platform does not
 * know", and the app decides its own fallback (a per-user zone, UTC, or
 * asking).
 */
export function getCompanyTimezone(env: CompanyTimezoneEnv | null | undefined): string | undefined {
  return validZone(env?.COMPANY_TIMEZONE);
}

/** The trimmed zone when `Intl` accepts it, else `undefined`. */
function validZone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const zone = raw.trim();
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/*
 * The company's "today" (sprigr-team#15956). Workers run in UTC, so
 * `new Date().toISOString().slice(0, 10)` is the UTC day: yesterday in Sydney
 * until 10 or 11am, tomorrow on the US west coast from the afternoon.
 */

const DAY_MS = 86_400_000;

/** Wall-clock minus UTC at instant `ms` in `zone`, in ms (e.g. +11h in Sydney in summer). */
function zoneOffsetMs(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Floor to the second Intl shows; a plain `ms % 1000` is negative before 1970 and would round up.
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * YYYY-MM-DD of instant `ms` in `zone`; the UTC day when `zone` is undefined.
 * Throws a RangeError on a zone `Intl` does not know, so pass a validated one
 * (`getCompanyTimezone` or `companyToday` never hand back an invalid zone).
 */
export function localDate(ms: number, zone: string | undefined): string {
  if (!zone) return new Date(ms).toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/**
 * Midnight that starts the local day containing `ms`, as unix ms; UTC midnight
 * when `zone` is undefined. Correct on DST change days: the offset is re-read
 * at the candidate midnight, since it can differ from the offset at `ms`.
 */
export function startOfLocalDay(ms: number, zone: string | undefined): number {
  if (!zone) return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
  const local = ms + zoneOffsetMs(ms, zone);
  const localMidnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  const guess = localMidnight - zoneOffsetMs(ms, zone);
  return localMidnight - zoneOffsetMs(guess, zone);
}

/**
 * `date` (YYYY-MM-DD) plus `n` calendar days. Zone-free: a calendar day is a
 * calendar day whatever the clocks did. Throws a RangeError on a string that is
 * not a real date, or a non-integer `n`.
 */
export function addDays(date: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !Number.isInteger(n)) throw new RangeError(`addDays: expected YYYY-MM-DD and an integer, got ${JSON.stringify(date)}, ${n}`);
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(base).toISOString().slice(0, 10) !== date) throw new RangeError(`addDays: ${JSON.stringify(date)} is not a calendar date`);
  return new Date(base + n * DAY_MS).toISOString().slice(0, 10);
}

/** Which zone `companyToday` used. */
export type DayZoneSource = 'provider' | 'company' | 'utc';

/** The day `companyToday` resolved, with the zone that produced it, for an `as_of` / `timezone` echo. */
export interface CompanyToday {
  date: string;
  zone: string;
  source: DayZoneSource;
}

/**
 * The tenant's today. Precedence: a valid `providerZone` (the Xero org, the
 * simPRO business, the Shopify shop), then the company zone from
 * `COMPANY_TIMEZONE`, then UTC. An invalid or empty provider zone falls
 * through rather than throwing. `nowMs` defaults to `Date.now()`.
 */
export function companyToday(
  env: CompanyTimezoneEnv | null | undefined,
  opts: { providerZone?: string | null; nowMs?: number } = {},
): CompanyToday {
  const now = opts.nowMs ?? Date.now();
  const provider = validZone(opts.providerZone);
  if (provider) return { date: localDate(now, provider), zone: provider, source: 'provider' };
  const company = getCompanyTimezone(env);
  if (company) return { date: localDate(now, company), zone: company, source: 'company' };
  return { date: localDate(now, undefined), zone: 'UTC', source: 'utc' };
}

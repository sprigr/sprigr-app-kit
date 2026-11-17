/**
 * The company's "today" (sprigr-team#15956). Workers run in UTC, so an app that
 * takes `new Date().toISOString().slice(0, 10)` dates a payment, a timecard or a
 * "days overdue" figure by the UTC day. In Sydney that is yesterday until 10 or
 * 11am; in Auckland until 12 or 1pm; west of UTC it is tomorrow from the
 * afternoon. These pin the local day, local midnight across DST, calendar
 * arithmetic, and the provider, company, UTC precedence.
 */
import { describe, expect, it } from 'vitest';
import { addDays, companyToday, localDate, startOfLocalDay } from '../src/index';

const at = (iso: string) => Date.parse(iso);

describe('localDate: the calendar day of an instant in a zone (#15956)', () => {
  it('Sydney is already on the next day while UTC is not', () => {
    // 13:30Z on the 17th is 00:30 AEDT (+11) on the 18th.
    expect(localDate(at('2026-11-17T13:30:00Z'), 'Australia/Sydney')).toBe('2026-11-18');
    expect(localDate(at('2026-11-17T12:30:00Z'), 'Australia/Sydney')).toBe('2026-11-17');
  });

  it('Auckland in daylight time is 13 hours ahead', () => {
    // 11:30Z on the 17th is 00:30 NZDT (+13) on the 18th.
    expect(localDate(at('2026-11-17T11:30:00Z'), 'Pacific/Auckland')).toBe('2026-11-18');
  });

  it('a zone west of UTC is still on the previous day', () => {
    // 05:00Z on the 18th is 21:00 PST (-8) on the 17th.
    expect(localDate(at('2026-11-18T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-17');
  });

  it('is the UTC day when there is no zone', () => {
    expect(localDate(at('2026-11-17T23:59:59Z'), undefined)).toBe('2026-11-17');
    expect(localDate(at('2026-11-18T00:00:00Z'), undefined)).toBe('2026-11-18');
  });

  it('pads month and day to two digits', () => {
    expect(localDate(at('2026-01-04T20:00:00Z'), 'Australia/Brisbane')).toBe('2026-01-05');
  });
});

describe('startOfLocalDay: local midnight as unix ms, across DST (#15956)', () => {
  it('Sydney on the day daylight time starts: midnight was still +10', () => {
    // 4 Oct 2026: clocks go 02:00 AEST -> 03:00 AEDT. Noon AEDT is 01:00Z;
    // that day's midnight was AEST, 14:00Z on the 3rd.
    expect(startOfLocalDay(at('2026-10-04T01:00:00Z'), 'Australia/Sydney')).toBe(at('2026-10-03T14:00:00Z'));
  });

  it('New York on the day daylight time starts: midnight was still -5', () => {
    // 8 Mar 2026: 02:00 EST -> 03:00 EDT. Noon EDT is 16:00Z; midnight EST is 05:00Z.
    expect(startOfLocalDay(at('2026-03-08T16:00:00Z'), 'America/New_York')).toBe(at('2026-03-08T05:00:00Z'));
  });

  it('Auckland on the day daylight time ends: midnight was still +13', () => {
    // 5 Apr 2026: 03:00 NZDT -> 02:00 NZST. Noon NZST is 00:00Z; midnight NZDT is 11:00Z on the 4th.
    expect(startOfLocalDay(at('2026-04-05T00:00:00Z'), 'Pacific/Auckland')).toBe(at('2026-04-04T11:00:00Z'));
  });

  it('a whole-second instant past midnight maps back to that midnight', () => {
    expect(startOfLocalDay(at('2026-11-17T13:00:01Z'), 'Australia/Sydney')).toBe(at('2026-11-17T13:00:00Z'));
  });

  it('is UTC midnight when there is no zone', () => {
    expect(startOfLocalDay(at('2026-11-17T18:45:12.345Z'), undefined)).toBe(at('2026-11-17T00:00:00Z'));
  });
});

describe('addDays: calendar arithmetic on YYYY-MM-DD (#15956)', () => {
  it('rolls over month, year and a leap day', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-17', 0)).toBe('2026-11-17');
    expect(addDays('2026-11-17', -365)).toBe('2025-11-17');
  });

  it('refuses a string that is not a real calendar date', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('17/11/2026', 1)).toThrow(RangeError);
  });
});

describe('companyToday: provider zone, then company zone, then UTC (#15956)', () => {
  const now = at('2026-11-17T13:30:00Z'); // 18th in Sydney, 17th in UTC and Perth

  it('uses the company zone from the binding', () => {
    expect(companyToday({ COMPANY_TIMEZONE: 'Australia/Sydney' }, { nowMs: now })).toEqual({
      date: '2026-11-18',
      zone: 'Australia/Sydney',
      source: 'company',
    });
  });

  it('a valid provider zone wins over the company zone', () => {
    expect(companyToday({ COMPANY_TIMEZONE: 'Australia/Sydney' }, { providerZone: 'Australia/Perth', nowMs: now })).toEqual({
      date: '2026-11-17',
      zone: 'Australia/Perth',
      source: 'provider',
    });
  });

  it('an invalid or empty provider zone falls through to the company zone', () => {
    for (const providerZone of ['Mars/Olympus_Mons', '', null, undefined]) {
      expect(companyToday({ COMPANY_TIMEZONE: 'Australia/Sydney' }, { providerZone, nowMs: now }).source).toBe('company');
    }
  });

  it('is the UTC day, and says so, when neither has a zone', () => {
    expect(companyToday({}, { nowMs: now })).toEqual({ date: '2026-11-17', zone: 'UTC', source: 'utc' });
    expect(companyToday(undefined, { nowMs: now })).toEqual({ date: '2026-11-17', zone: 'UTC', source: 'utc' });
  });

  it('defaults to the current instant', () => {
    const before = new Date().toISOString().slice(0, 10);
    const got = companyToday({}).date;
    const after = new Date().toISOString().slice(0, 10);
    expect([before, after]).toContain(got);
  });
});

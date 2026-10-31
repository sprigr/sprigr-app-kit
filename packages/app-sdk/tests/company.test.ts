/**
 * getCompanyTimezone (sprigr-team#11006): the platform binds the install's
 * company IANA zone as `COMPANY_TIMEZONE` at upload (sprigr-team#11038), but
 * only when the company has a valid zone. An app reads it to compute the
 * tenant's "today"; it must never invent one, and a bad value must not throw
 * in the middle of a handler.
 */
import { describe, expect, it } from 'vitest';
import { getCompanyTimezone } from '../src/company';

describe('getCompanyTimezone (#11006)', () => {
  it('returns the bound zone when it is a valid IANA name', () => {
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: 'Australia/Brisbane' })).toBe('Australia/Brisbane');
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: 'Africa/Johannesburg' })).toBe('Africa/Johannesburg');
  });

  it('trims surrounding whitespace', () => {
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: '  Australia/Sydney \n' })).toBe('Australia/Sydney');
  });

  it('is undefined when the binding is absent, so the app decides its own fallback', () => {
    expect(getCompanyTimezone({})).toBeUndefined();
    expect(getCompanyTimezone(undefined)).toBeUndefined();
    expect(getCompanyTimezone(null)).toBeUndefined();
  });

  it('is undefined for an empty or non-string value, never a default zone', () => {
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: '' })).toBeUndefined();
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: '   ' })).toBeUndefined();
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: 10 as unknown as string })).toBeUndefined();
  });

  it('is undefined, without throwing, for a name Intl does not accept', () => {
    expect(() => getCompanyTimezone({ COMPANY_TIMEZONE: 'Mars/Olympus_Mons' })).not.toThrow();
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: 'Mars/Olympus_Mons' })).toBeUndefined();
    expect(getCompanyTimezone({ COMPANY_TIMEZONE: 'not a zone' })).toBeUndefined();
  });

  it('accepts a zone a caller can hand straight to Intl', () => {
    const zone = getCompanyTimezone({ COMPANY_TIMEZONE: 'Asia/Calcutta' });
    expect(zone).toBe('Asia/Calcutta');
    expect(() => new Intl.DateTimeFormat('en-AU', { timeZone: zone }).format(new Date(0))).not.toThrow();
  });
});

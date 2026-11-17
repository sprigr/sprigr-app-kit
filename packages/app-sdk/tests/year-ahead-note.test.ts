import { describe, expect, it } from 'vitest';
import { yearAheadNote } from '../src/year-ahead-note';

// sprigr-team#15974: an event booked a year out, two days before the same
// date this year, went through with the year never said.
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 3, 0); // 2026-11-17 03:00Z
const daysOut = (n: number, now = NOW) => new Date(now + n * DAY).toISOString().slice(0, 10);

describe('yearAheadNote', () => {
  it('names the year when the same date this year is two days away', () => {
    const note = yearAheadNote('2027-11-19T10:00:00', { nowMs: NOW });
    expect(note).toContain('19 November 2027');
    expect(note).toContain('19 November 2026 is 2 days away');
    expect(note).not.toMatch(/refuse|do not create|cancel/i);
  });

  it('says nothing for the same date in the current year', () => {
    expect(yearAheadNote('2026-11-19T10:00:00', { nowMs: NOW })).toBeNull();
  });

  it('says nothing for an ordinary far-future date whose date this year has passed', () => {
    expect(yearAheadNote('2027-06-01T10:00:00', { nowMs: NOW })).toBeNull();
  });

  it('says nothing when the same date a year earlier is more than 31 days away', () => {
    expect(yearAheadNote(`${daysOut(365 + 32)}T10:00:00`, { nowMs: NOW })).toBeNull();
    expect(yearAheadNote(`${daysOut(365 + 31)}T10:00:00`, { nowMs: NOW })).not.toBeNull();
  });

  it('covers a December ask for early January, across the year boundary', () => {
    const dec20 = Date.UTC(2026, 11, 20, 3, 0);
    const note = yearAheadNote('2028-01-03T09:00:00', { nowMs: dec20 });
    expect(note).toContain('3 January 2028');
    expect(note).toContain('3 January 2027 is 14 days away');
    expect(yearAheadNote('2027-01-03T09:00:00', { nowMs: dec20 })).toBeNull();
  });

  it('says nothing at exactly 330 or 331 days out', () => {
    expect(yearAheadNote(`${daysOut(330)}T10:00:00`, { nowMs: NOW })).toBeNull();
    expect(yearAheadNote(`${daysOut(331)}T10:00:00`, { nowMs: NOW })).toBeNull();
  });

  it('reads the date as the caller wrote it, whatever the offset', () => {
    // 00:30 at +11:00 is still the 18th in UTC; the person asked for the 19th.
    const note = yearAheadNote('2027-11-19T00:30:00+11:00', { nowMs: NOW });
    expect(note).toContain('19 November 2027');
    expect(yearAheadNote('2027-11-19T23:30:00-10:00', { nowMs: NOW })).toContain('19 November 2027');
  });

  it('says nothing for 29 February when the year before has no such day', () => {
    const feb20 = Date.UTC(2027, 1, 20, 3, 0);
    expect(yearAheadNote('2028-02-29T10:00:00', { nowMs: feb20 })).toBeNull();
  });

  it('flags 28 February a year out when the same date is a week away', () => {
    const feb21_2028 = Date.UTC(2028, 1, 21, 3, 0);
    expect(yearAheadNote('2029-02-28T10:00:00', { nowMs: feb21_2028 })).toContain('28 February 2028 is 7 days away');
  });

  it('says today and tomorrow in words', () => {
    expect(yearAheadNote('2027-11-17T10:00:00', { nowMs: NOW })).toContain('17 November 2026 is today');
    expect(yearAheadNote('2027-11-18T10:00:00', { nowMs: NOW })).toContain('18 November 2026 is tomorrow');
  });

  it('says nothing for a start it cannot read as a real date', () => {
    expect(yearAheadNote('2027-02-29T10:00:00', { nowMs: NOW })).toBeNull();
    expect(yearAheadNote('next Friday', { nowMs: NOW })).toBeNull();
    expect(yearAheadNote('', { nowMs: NOW })).toBeNull();
  });
});

describe('yearAheadNote: today is the caller\'s day, not the UTC day', () => {
  it('Sydney in the morning, while UTC is still the day before, says "is today"', () => {
    // 2026-11-18T22:00Z is 09:00 on the 19th in Sydney.
    const at = Date.UTC(2026, 10, 18, 22, 0);
    expect(yearAheadNote('2027-11-19T10:00:00', { nowMs: at, timeZone: 'Australia/Sydney' })).toContain(
      '19 November 2026 is today',
    );
  });

  it('Los Angeles in the evening, while UTC is already the next day, still fires and says "is today"', () => {
    // 2026-11-20T03:00Z is 19:00 on the 19th in Los Angeles.
    const at = Date.UTC(2026, 10, 20, 3, 0);
    const note = yearAheadNote('2027-11-19T10:00:00', { nowMs: at, timeZone: 'America/Los_Angeles' });
    expect(note).not.toBeNull();
    expect(note).toContain('19 November 2026 is today');
  });

  it('Sydney after midnight, while UTC is still the 19th, says nothing: the date has passed there', () => {
    // 2026-11-19T14:00Z is 01:00 on the 20th in Sydney.
    const at = Date.UTC(2026, 10, 19, 14, 0);
    expect(yearAheadNote('2027-11-19T10:00:00', { nowMs: at, timeZone: 'Australia/Sydney' })).toBeNull();
  });

  it('an invalid zone is read as UTC rather than throwing', () => {
    const at = Date.UTC(2026, 10, 18, 22, 0);
    const utc = yearAheadNote('2027-11-19T10:00:00', { nowMs: at });
    expect(utc).toContain('19 November 2026 is tomorrow');
    expect(yearAheadNote('2027-11-19T10:00:00', { nowMs: at, timeZone: 'Not/A_Zone' })).toBe(utc);
    expect(yearAheadNote('2027-11-19T10:00:00', { nowMs: at, timeZone: '' })).toBe(utc);
  });
});

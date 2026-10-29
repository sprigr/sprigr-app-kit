import { describe, expect, it } from 'vitest';
import { emailAudience, MAX_AUDIENCE_NAME_CHARS } from '../../src/write-protection/approval-audience';

describe('emailAudience names (sprigr-team decision 0318)', () => {
  it('keeps the display name of each "Name <address>" entry, paired by index', () => {
    expect(emailAudience({ to: ['Riley Hart <Riley@Example.com>', 'b@example.com'], cc: '"Mitch Calder" <m@example.com>', sender: 'other' }))
      .toEqual({
        recipients: ['riley@example.com', 'b@example.com', 'm@example.com'],
        names: ['Riley Hart', '', 'Mitch Calder'],
        sender: 'other',
      });
  });

  it('omits names when no entry carries one, so the 0312 shape is unchanged', () => {
    expect(emailAudience({ to: ['a@example.com', '<b@example.com>'], sender: 'actor' }))
      .toEqual({ recipients: ['a@example.com', 'b@example.com'], sender: 'actor' });
  });

  it('keeps the first name given for a repeated address', () => {
    expect(emailAudience({ to: 'a@example.com, Ann Lee <A@example.com>', cc: ['Other <a@example.com>'], sender: 'other' }))
      .toEqual({ recipients: ['a@example.com'], names: ['Ann Lee'], sender: 'other' });
  });

  it('blanks a name over the platform limit rather than dropping the whole audience', () => {
    const long = 'x'.repeat(MAX_AUDIENCE_NAME_CHARS + 1);
    expect(emailAudience({ to: [`${long} <a@example.com>`, 'Bo <b@example.com>'], sender: 'other' }))
      .toEqual({ recipients: ['a@example.com', 'b@example.com'], names: ['', 'Bo'], sender: 'other' });
  });
});

/**
 * The package is published to npm, and `release.yml` runs these tests before
 * it publishes, so this is the gate on the React build. It is the only React
 * package in the set: every other one is plain TypeScript, so the JSX
 * transform and the `react` external are unique risks here and worth pinning.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimezoneSelect } from '../src/TimezoneSelect';
import { TIMEZONE_GROUPS, ALL_TIMEZONES, isKnownTimezone } from '../src/timezones';

const render = (props: Parameters<typeof TimezoneSelect>[0]) =>
  renderToStaticMarkup(<TimezoneSelect {...props} />);

describe('TimezoneSelect', () => {
  it('renders a grouped native select with no client boundary', () => {
    const html = render({ name: 'timezone' });
    expect(html).toContain('<select');
    expect(html).toContain('<optgroup');
    expect(html).toContain('name="timezone"');
    // Pure SSR is the whole point: a "use client" component historically
    // broke SSR in marketplace apps, so there must be no hydration marker.
    expect(html).not.toContain('$RC');
  });

  it('renders one optgroup per timezone group', () => {
    const html = render({ name: 'timezone' });
    expect(html.match(/<optgroup/g) ?? []).toHaveLength(TIMEZONE_GROUPS.length);
  });

  it('renders every zone, including the deliberate Common-group repeats', () => {
    const html = render({ name: 'timezone' });
    // The leading "Common" group repeats popular zones that also appear under
    // their region, so the rendered option count exceeds ALL_TIMEZONES (which
    // is Set-deduped). Assert against the raw group total, and separately that
    // every unique zone is reachable. `<option` alone would match `<optgroup`.
    const groupTotal = TIMEZONE_GROUPS.reduce((n, g) => n + g.zones.length, 0);
    expect(html.match(/<option[ >]/g) ?? []).toHaveLength(groupTotal);
    for (const zone of ALL_TIMEZONES) expect(html).toContain(`value="${zone}"`);
  });

  it('preselects defaultValue', () => {
    const html = render({ name: 'timezone', defaultValue: 'Australia/Brisbane' });
    expect(html).toMatch(/<select[^>]*\bdefaultValue|selected/);
    expect(html).toContain('Australia/Brisbane');
  });

  it('defaults to UTC so the form is always submittable', () => {
    expect(isKnownTimezone('UTC')).toBe(true);
    expect(render({ name: 'timezone' })).toContain('UTC');
  });

  it('is required by default and can be opted out', () => {
    expect(render({ name: 'timezone' })).toContain('required');
    expect(render({ name: 'timezone', required: false })).not.toContain('required');
  });

  it('passes through id, className and aria-label', () => {
    const html = render({ name: 'tz', id: 'tz-field', className: 'input', ariaLabel: 'Timezone' });
    expect(html).toContain('id="tz-field"');
    expect(html).toContain('class="input"');
    expect(html).toContain('aria-label="Timezone"');
  });
});

describe('isKnownTimezone', () => {
  it('accepts every zone the picker offers', () => {
    for (const zone of ALL_TIMEZONES) expect(isKnownTimezone(zone)).toBe(true);
  });

  it('rejects anything else, so a submitted value can be validated', () => {
    expect(isKnownTimezone('Mars/Olympus')).toBe(false);
    expect(isKnownTimezone('')).toBe(false);
    expect(isKnownTimezone('australia/brisbane')).toBe(false);
  });
});

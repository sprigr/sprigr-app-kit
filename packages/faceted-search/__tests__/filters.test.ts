import { describe, expect, it } from 'vitest';
import { buildFilterString, combineFilters, escapeFilterValue } from '../src/utils/filters';

const sel = (o: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('escapeFilterValue', () => {
  it('backslash-escapes embedded double quotes', () => {
    expect(escapeFilterValue('a"b')).toBe('a\\"b');
    expect(escapeFilterValue('he said "hi"')).toBe('he said \\"hi\\"');
  });
  it('leaves quote-free values untouched', () => {
    expect(escapeFilterValue("O'Brien")).toBe("O'Brien");
  });
});

describe('buildFilterString (engine-native flat CNF)', () => {
  it('single value becomes unquoted attr:value', () => {
    expect(buildFilterString(sel({ status: ['active'] }))).toBe('status:active');
  });

  it('multiple values for one attr become a flat OR clause with no parentheses', () => {
    expect(buildFilterString(sel({ status: ['active', 'sold'] }))).toBe(
      'status:active OR status:sold',
    );
  });

  it('joins multiple attrs with a comma (AND)', () => {
    expect(
      buildFilterString(sel({ status: ['active'], property_type: ['house'] })),
    ).toBe('status:active,property_type:house');
  });

  it('leaves values with spaces and stray quotes unquoted (raw substring match)', () => {
    // The engine compares the raw substring after the first colon, so an
    // embedded quote or space must ride through verbatim to match the stored
    // facet value.
    expect(buildFilterString(sel({ name: ['26" monitor'] }))).toBe('name:26" monitor');
    expect(buildFilterString(sel({ suburb: ['St Kilda East'] }))).toBe('suburb:St Kilda East');
  });

  it('quotes only values containing a separator substring (forward-compat escape hatch)', () => {
    expect(buildFilterString(sel({ brand: ['Salt, Pepper'] }))).toBe('brand:"Salt, Pepper"');
    expect(buildFilterString(sel({ title: ['this OR that'] }))).toBe('title:"this OR that"');
    expect(buildFilterString(sel({ title: ['rock AND roll'] }))).toBe('title:"rock AND roll"');
    // Bare unpadded AND/OR substrings are not separators and stay unquoted.
    expect(buildFilterString(sel({ brand: ['LANDROVER'] }))).toBe('brand:LANDROVER');
  });

  it('emits a range term when either bound is set', () => {
    expect(buildFilterString({}, { price: { min: 100, max: 500 } })).toBe('price:100 TO 500');
    expect(buildFilterString({}, { price: { min: 100, max: null } })).toBe('price:100 TO 100000000');
    expect(buildFilterString({}, { price: { min: null, max: 500 } })).toBe('price:0 TO 500');
  });

  it('omits a range term when both bounds are null', () => {
    expect(buildFilterString({}, { price: { min: null, max: null } })).toBe('');
  });

  it('honours a custom range ceiling', () => {
    expect(buildFilterString({}, { land: { min: 5, max: null } }, 9999)).toBe('land:5 TO 9999');
  });

  it('combines facets and ranges in order', () => {
    expect(
      buildFilterString(sel({ status: ['active', 'sold'] }), { price: { min: 100, max: null } }),
    ).toBe('status:active OR status:sold,price:100 TO 100000000');
  });

  it('skips empty facet sets', () => {
    expect(buildFilterString(sel({ status: [], property_type: ['house'] }))).toBe(
      'property_type:house',
    );
  });
});

describe('combineFilters (baseFilter scoping)', () => {
  const BASE = 'status:qualified OR status:manual_review';

  it('baseFilter alone: stands in when the user filter is empty', () => {
    expect(combineFilters(BASE, '')).toBe(BASE);
    expect(combineFilters(BASE, buildFilterString(sel({})))).toBe(BASE);
  });

  it('baseFilter + facets + ranges: comma-ANDed in front of the user expression', () => {
    const user = buildFilterString(
      sel({ status: ['qualified'], property_type: ['house'] }),
      { price: { min: 100, max: 500 } },
    );
    expect(combineFilters(BASE, user)).toBe(
      `${BASE},status:qualified,property_type:house,price:100 TO 500`,
    );
  });

  it('empty or whitespace-only baseFilter is ignored', () => {
    const user = buildFilterString(sel({ status: ['active'] }));
    expect(combineFilters(undefined, user)).toBe(user);
    expect(combineFilters('', user)).toBe(user);
    expect(combineFilters('   ', user)).toBe(user);
    expect(combineFilters(undefined, '')).toBe('');
  });

  it('plain AND with a user selection on a base-constrained facet (no merging)', () => {
    // Selecting a value inside the base set stays satisfiable; a value outside
    // it would zero results. Either way the output is a plain comma-join, and
    // the flat OR clause binds tighter than the comma conjunction.
    const inside = buildFilterString(sel({ status: ['qualified'] }));
    expect(combineFilters(BASE, inside)).toBe(`${BASE},status:qualified`);
    const outside = buildFilterString(sel({ status: ['test_data_removed'] }));
    expect(combineFilters(BASE, outside)).toBe(`${BASE},status:test_data_removed`);
  });
});

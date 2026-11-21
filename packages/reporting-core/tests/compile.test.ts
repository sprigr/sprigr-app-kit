import { describe, it, expect } from 'vitest';
import { compileRollupView, compileView, inlineParams, isStageName, tablesIn, type CompiledView, type ViewState } from '../src';
import { fixtureModel } from './fixture';

const TODAY = '2026-11-21';
const base: ViewState = { mode: 'total', stream: 'sales', measures: ['sales'], period: { preset: 'current_month' }, group_by: 'branch' };

/** A view as the compiler returns it, a `?` for each typed value. */
function unwritten(change: Record<string, unknown> = {}, ctx: { maxSqlChars?: number; maxRows?: number; periodShape?: 'wide' | 'long' } = {}): CompiledView {
  const out = compileView(fixtureModel(), { ...base, ...change } as ViewState, { today: TODAY, ...ctx });
  if (!out.ok) throw new Error(`refused: ${out.reason}: ${out.detail}`);
  return out;
}

/** The same view with its typed values written into the statement, which is the form most of these tests read. */
function compiled(change: Record<string, unknown> = {}, ctx: { maxSqlChars?: number; maxRows?: number; periodShape?: 'wide' | 'long' } = {}): CompiledView {
  const out = unwritten(change, ctx);
  return { ...out, sql: inlineParams(out.sql, out.params) };
}

function refusal(change: Record<string, unknown>, ctx: { maxSqlChars?: number; maxRows?: number; periodShape?: 'wide' | 'long' } = {}): string {
  const out = compileView(fixtureModel(), { ...base, ...change } as ViewState, { today: TODAY, ...ctx });
  return out.ok ? 'did not refuse' : out.reason;
}

describe('compileView, total mode', () => {
  it('emits one statement that groups, ranks and pages', () => {
    const out = compiled();
    expect(out.sql).toBe([
      'WITH g AS (',
      'SELECT f."branch_code" AS "code", CAST(SUM(f."amount") AS DOUBLE) AS "m__sales", 0 AS "__total"',
      'FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'GROUP BY f."branch_code"',
      '), r AS (',
      'SELECT g.*, row_number() OVER (PARTITION BY "__total" ORDER BY "m__sales" DESC NULLS LAST, "code" ASC) AS "__rn",',
      'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
      'FROM g',
      ')',
      'SELECT * EXCLUDE ("__rn") FROM r',
      'WHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)',
      'ORDER BY "__total" DESC, "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'm__sales', '__total', '__rows']);
    expect(out.months).toEqual({ from: '2026-11', to: '2026-11' });
  });

  it('counts rows for a count measure', () => {
    expect(compiled({ measures: ['lines'] }).sql).toContain('CAST(COUNT(*) AS DOUBLE) AS "m__lines"');
  });

  it('pages after the total row, which is always returned', () => {
    const out = compiled({ limit: 50, offset: 100, options: { total_row: true } });
    expect(out.sql).toContain('GROUP BY GROUPING SETS ((f."branch_code"), ())');
    expect(out.sql).toContain('CAST(GROUPING(f."branch_code") AS INTEGER) AS "__total"');
    expect(out.sql).toContain('WHERE "__total" = 1 OR ("__rn" > 100 AND "__rn" <= 150)');
  });
});

describe('compileView, period mode', () => {
  const view = {
    mode: 'period',
    measures: ['sales', 'gp'],
    period: { preset: 'rolling_3' },
    group_by: 'product',
    properties: ['name', 'brand'],
    path: [{ dimension: 'department', selected: ['010'] }],
    keyword: "koala's 50%",
    options: { total_row: true },
  };

  it('numbers each row with its period once, and filters each column on that number', () => {
    const { sql } = compiled(view);
    expect(sql).toContain('CASE WHEN "sale_date" < DATE \'2026-10-01\' THEN 1 WHEN "sale_date" < DATE \'2026-11-01\' THEN 2 WHEN "sale_date" < DATE \'2026-12-01\' THEN 3 END AS "__b"');
    expect(sql).toContain('WHERE "sale_date" >= DATE \'2026-09-01\' AND "sale_date" < DATE \'2026-12-01\'');
    expect(sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__b" = 2) AS DOUBLE) AS "b2__sales"');
  });

  it('computes a formula measure per period from that period\'s sums, with the division guarded', () => {
    const { sql } = compiled(view);
    expect(sql).toContain('/ NULLIF((SUM(f."amount") FILTER (WHERE f."__b" = 1)), 0)) AS DOUBLE) AS "b1__gp"');
    expect(sql).toContain('/ NULLIF((SUM(f."amount")), 0)) AS DOUBLE) AS "m__gp"');
  });

  it('drills through a parent dimension without joining tables it does not need', () => {
    const { sql } = compiled(view);
    expect(sql).toContain('LEFT JOIN "products" AS "d_product" ON "d_product"."code" = f."product_code"');
    expect(sql).toContain('CAST("d_product"."dept" AS VARCHAR) IN (\'010\')');
    expect(sql).not.toContain('"departments"');
  });

  it('escapes the keyword as a literal and as a pattern', () => {
    const { sql } = compiled(view);
    expect(sql).toContain("CAST(f.\"product_code\" AS VARCHAR) ILIKE '%koala''s 50\\%%' ESCAPE '\\'");
    expect(sql).toContain("\"d_product\".\"name\" ILIKE '%koala''s 50\\%%' ESCAPE '\\'");
  });

  it('blanks properties on the total row', () => {
    expect(compiled(view).sql).toContain('CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."brand") END AS "prop__brand"');
  });

  it('lists columns in display order, oldest period first unless reversed', () => {
    expect(compiled(view).columns.map((c) => c.name)).toEqual([
      'code', 'prop__name', 'prop__brand',
      'b1__sales', 'b2__sales', 'b3__sales', 'm__sales',
      'b1__gp', 'b2__gp', 'b3__gp', 'm__gp',
      '__total', '__rows',
    ]);
    const reversed = compiled({ ...view, options: { reverse_periods: true } }).columns.map((c) => c.name);
    expect(reversed.slice(3, 7)).toEqual(['b3__sales', 'b2__sales', 'b1__sales', 'm__sales']);
    expect(compiled(view).months).toEqual({ from: '2026-09', to: '2026-11' });
  });

  it('labels each period column and carries its dates', () => {
    const column = compiled(view).columns.find((c) => c.name === 'b1__sales');
    expect(column).toMatchObject({ label: 'Sales Sep 2026', measure: 'sales', format: 'currency', period: { from: '2026-09-01', to: '2026-10-01', days: 30 } });
  });

  it('sorts by a period column', () => {
    expect(compiled({ ...view, sort: { by: 'period.2.sales', dir: 'asc' } }).sql).toContain('ORDER BY "b2__sales" ASC NULLS LAST, "code" ASC');
  });
});

describe('compileView, dimensions and filters', () => {
  it('groups by an attribute of another dimension, joining the parent before the lookup', () => {
    const { sql } = compiled({ group_by: 'department', properties: ['name'] });
    expect(sql).toContain('SELECT "d_product"."dept" AS "code", any_value("d_department"."name") AS "prop__name"');
    expect(sql).toContain('LEFT JOIN "departments" AS "d_department" ON "d_department"."code" = "d_product"."dept"');
    expect(sql.indexOf('LEFT JOIN "products"')).toBeLessThan(sql.indexOf('LEFT JOIN "departments"'));
    expect(sql).toContain('GROUP BY "d_product"."dept"');
  });

  it('combines filter groups and keeps rows with no code under not_in', () => {
    const { sql } = compiled({
      filters: { op: 'and', rules: [
        { dimension: 'branch', cmp: 'not_in', values: ['9'] },
        { op: 'or', rules: [
          { dimension: 'product', property: 'brand', cmp: 'in', values: ['Acme'] },
          { dimension: 'product', cmp: 'in', values: ['P1', 'P2'] },
        ] },
      ] },
    });
    expect(sql).toContain('WHERE ((f."branch_code" IS NULL OR CAST(f."branch_code" AS VARCHAR) NOT IN (\'9\')) AND (CAST("d_product"."brand" AS VARCHAR) IN (\'Acme\') OR CAST(f."product_code" AS VARCHAR) IN (\'P1\', \'P2\')))');
  });

  it('keeps a quote in a selected value inside its literal', () => {
    expect(compiled({ path: [{ dimension: 'branch', selected: ["x' OR 1=1 --"] }] }).sql).toContain("IN ('x'' OR 1=1 --')");
  });

  it('writes a ? for each typed value and returns the values beside the statement', () => {
    const out = unwritten({ group_by: 'product', path: [{ dimension: 'branch', selected: ["x' OR 1=1 --", 'Home/Garden'] }], keyword: "koala's 50%" });
    expect(out.sql).not.toMatch(/Garden|koala|1=1/);
    expect(out.sql.match(/\?/g)).toHaveLength(out.params.length);
    expect(new Set(out.params)).toEqual(new Set(["x' OR 1=1 --", 'Home/Garden', "%koala's 50\\%%"]));
    const sql = inlineParams(out.sql, out.params);
    expect(sql).toContain("IN ('x'' OR 1=1 --', 'Home/Garden')");
    expect(sql).toContain("ILIKE '%koala''s 50\\%%' ESCAPE '\\'");
  });

  it('returns no values for a view with nothing typed', () => {
    const out = unwritten();
    expect(out.params).toEqual([]);
    expect(out.sql).not.toContain('?');
  });

  it('returns a typed value whole, whatever characters it holds', () => {
    const odd = ['a\u0001b\u0002c\u0003d', '\u00031', '?'];
    const out = unwritten({ path: [{ dimension: 'product', selected: odd }] });
    expect(new Set(out.params)).toEqual(new Set(odd));
    expect(out.sql).not.toMatch(/[\u0001-\u0003]/);
    expect(out.sql.match(/\?/g)).toHaveLength(out.params.length);
  });

  it('writes values into a statement, leaving a ? in a literal or a quoted name alone', () => {
    expect(inlineParams('SELECT \'?\' AS "a?b" FROM "t" WHERE x = ? AND y IN (?, ?)', ["it's", 'b', 'c?']))
      .toBe('SELECT \'?\' AS "a?b" FROM "t" WHERE x = \'it\'\'s\' AND y IN (\'b\', \'c?\')');
    expect(() => inlineParams('SELECT ?', [])).toThrow('bad_params');
    expect(() => inlineParams('SELECT ?', ['a', 'b'])).toThrow('bad_params');
  });

  it('ignores an empty top-level filter', () => {
    expect(compiled({ filters: { op: 'and', rules: [] } }).sql).toBe(compiled().sql);
  });
});

describe('compileView refusals', () => {
  it.each([
    [{ mode: 'pivot' }, 'mode_unsupported'],
    [{ mode: 'matrix' }, 'bad_across'],
    [{ mode: 'matrix', across: { dimension: 'branch' } }, 'bad_across'],
    [{ mode: 'matrix', across: { dimension: 'product', order: 'random' } }, 'bad_across'],
    [{ mode: 'matrix', across: { dimension: 'product', limit: 0 } }, 'bad_across'],
    [{ mode: 'matrix', across: { dimension: 'customer' } }, 'dimension_not_on_stream'],
    [{ mode: 'matrix', across: { dimension: 'nope' } }, 'unknown_dimension'],
    [{ mode: 'matrix', across: { dimension: 'product' }, limit: 0 }, 'bad_paging'],
    [{ mode: 'matrix', across: { dimension: 'product', limit: 2000 } }, 'bad_paging'],
    [{ mode: 'matrix', across: { dimension: 'product' }, options: { activity: 'all' } }, 'option_unsupported'],
    [{ mode: 'matrix', across: { dimension: 'product' }, sort: { by: 'period.1.sales', dir: 'asc' } }, 'bad_sort'],
    [{ mode: 'stream', measures: ['sales', 'ordered'] }, 'dimension_not_on_stream'],
    [{ mode: 'stream', group_by: 'product', options: { activity: 'all' } }, 'option_unsupported'],
    [{ mode: 'stream', group_by: 'product', sort: { by: 'period.1.sales', dir: 'asc' } }, 'bad_sort'],
    [{ measures: ['fill'] }, 'measure_not_on_stream'],
    [{ mode: 'variance', compare: 'last_decade' }, 'option_unsupported'],
    [{ sort: { by: 'variance.sales', dir: 'asc' } }, 'bad_sort'],
    [{ stream: 'nope' }, 'unknown_stream'],
    [{ measures: [] }, 'no_measures'],
    [{ measures: ['sales', 'sales'] }, 'duplicate_measure'],
    [{ measures: ['nope'] }, 'unknown_measure'],
    [{ mode: 'transaction', measures: ['soh'] }, 'snapshot_measure_unsupported'],
    [{ measures: ['ordered'] }, 'measure_not_on_stream'],
    [{ group_by: 'customer' }, 'dimension_not_on_stream'],
    [{ group_by: 'nope' }, 'unknown_dimension'],
    [{ properties: ['colour'] }, 'unknown_property'],
    [{ properties: ['name'] }, 'unknown_property'],
    [{ path: [{ dimension: 'branch', selected: [] }] }, 'empty_selection'],
    [{ filters: { op: 'or', rules: [{ dimension: 'branch', cmp: 'in', values: ['1'] }, { measure: 'sales', cmp: '<', value: 1 }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ op: 'or', rules: [{ dimension: 'branch', cmp: 'in', values: ['1'] }, { measure: 'sales', cmp: '<', value: 1 }] }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ measure: 'sales', cmp: 'like', value: 1 }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ measure: 'sales', of: 'variance', cmp: '<', value: 1 }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ measure: 'sales', cmp: '<', value: Number.NaN }] } }, 'bad_number'],
    [{ filters: { op: 'and', rules: [{ measure: 'nope', cmp: '<', value: 1 }] } }, 'unknown_measure'],
    [{ filters: { op: 'and', rules: [{ measure: 'ordered', cmp: '<', value: 1 }] } }, 'measure_not_on_stream'],
    [{ filters: { op: 'and', rules: [{ op: 'and', rules: [{ op: 'and', rules: [{ op: 'and', rules: [{ op: 'and', rules: [{ dimension: 'branch', cmp: 'in', values: ['1'] }] }] }] }] }] } }, 'filter_too_deep'],
    [{ mode: 'transaction', options: { total_row: true } }, 'option_unsupported'],
    [{ mode: 'transaction', columns: ['nope'] }, 'unknown_column'],
    [{ mode: 'transaction', sort: { by: 'code', dir: 'asc' } }, 'bad_sort'],
    [{ mode: 'transaction', filters: { op: 'and', rules: [{ measure: 'sales', cmp: '<', value: 1 }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ op: 'or', rules: [] }] } }, 'empty_filter'],
    [{ sort: { by: 'total.cost', dir: 'desc' } }, 'bad_sort'],
    [{ sort: { by: 'total.sales', dir: 'sideways' } }, 'bad_sort'],
    [{ limit: 5000 }, 'bad_paging'],
    [{ limit: 2000, options: { total_row: true } }, 'bad_paging'],
    [{ offset: -1 }, 'bad_paging'],
    [{ period: { named: 'nope' } }, 'unknown_period'],
    [{ options: { activity: 'sometimes' } }, 'option_unsupported'],
    [{ options: { activity: 'all' } }, 'dimension_has_no_table'],
    [{ group_by: 'product', options: { others_row: true, activity: 'all' } }, 'option_unsupported'],
    [{ keyword: 'k'.repeat(201) }, 'keyword_too_long'],
  ])('refuses %j with %s', (change, reason) => {
    expect(refusal(change)).toBe(reason);
  });

  it('refuses a statement longer than the limit it is given', () => {
    expect(refusal({}, { maxSqlChars: 100 })).toBe('sql_too_long');
  });

  it('refuses a bad today', () => {
    const out = compileView(fixtureModel(), base, { today: 'yesterday' });
    expect(out.ok ? '' : out.reason).toBe('bad_date');
  });
});

describe('compileView, variance mode', () => {
  const view = { mode: 'variance', measures: ['sales', 'gp'], group_by: 'product', options: { total_row: true } };
  const now = '"sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\'';
  const then = '"sale_date" >= DATE \'2025-11-01\' AND "sale_date" < DATE \'2025-12-01\'';

  it('reads the period and the same dates a year earlier in one pass, flagging each row', () => {
    const out = compiled(view);
    expect(out.sql).toContain(`FROM (SELECT *, (${now}) AS "__cur", (${then}) AS "__prev" FROM "sales_lines" WHERE (${now}) OR (${then})) AS f`);
    expect(out.comparison).toEqual({ from: '2025-11-01', to: '2025-12-01' });
    expect(out.months).toEqual({ from: '2025-11', to: '2026-11' });
  });

  it('sums each window under its own flag and subtracts the two columns in a later stage', () => {
    const { sql } = compiled(view);
    expect(sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__cur") AS DOUBLE) AS "m__sales"');
    expect(sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__prev") AS DOUBLE) AS "prev__sales"');
    expect(sql).toContain('), v AS (\nSELECT g.*, COALESCE("m__sales", 0) - COALESCE("prev__sales", 0) AS "var__sales", (COALESCE("m__sales", 0) - "prev__sales") / NULLIF(abs("prev__sales"), 0) AS "varp__sales", ');
    expect(sql).toContain('SELECT v.*, row_number() OVER (PARTITION BY "__total" ORDER BY "m__sales" DESC NULLS LAST, "code" ASC) AS "__rn",');
  });

  it('gives each measure four columns, the last a percent', () => {
    const out = compiled(view);
    expect(out.columns.map((c) => c.name)).toEqual([
      'code', 'm__sales', 'prev__sales', 'var__sales', 'varp__sales', 'm__gp', 'prev__gp', 'var__gp', 'varp__gp', '__total', '__rows',
    ]);
    expect(out.columns.find((c) => c.name === 'prev__sales')).toMatchObject({
      label: 'Sales Previous year', part: 'previous', period: { from: '2025-11-01', to: '2025-12-01', days: 30 },
    });
    expect(out.columns.find((c) => c.name === 'varp__gp')).toMatchObject({ format: 'percent', part: 'variance_pct' });
  });

  it('compares with the period just before when asked', () => {
    const out = compiled({ ...view, compare: 'previous_period', period: { preset: 'rolling_3' } });
    expect(out.comparison).toEqual({ from: '2026-06-01', to: '2026-09-01' });
    expect(out.columns.find((c) => c.name === 'prev__sales')?.label).toBe('Sales Previous period');
    expect(out.months).toEqual({ from: '2026-06', to: '2026-11' });
  });

  it('sorts by a variance column and filters on one', () => {
    const { sql } = compiled({
      ...view,
      sort: { by: 'variance_pct.sales', dir: 'asc' },
      filters: { op: 'and', rules: [{ measure: 'sales', of: 'variance', cmp: '<', value: 0 }] },
    });
    expect(sql).toContain('ORDER BY "varp__sales" ASC NULLS LAST, "code" ASC');
    expect(sql).toContain('FROM v\nWHERE "__total" = 1 OR ("var__sales" < 0)\n)');
  });

  it('lets a period longer than a year overlap the year before it', () => {
    const out = compiled({ ...view, period: { custom: { from: '2025-01-01', to: '2026-06-30' } } });
    expect(out.comparison).toEqual({ from: '2024-01-01', to: '2025-07-01' });
    expect(out.sql).not.toContain('"__b"');
  });

  it('compares with a window given as a period of its own', () => {
    const out = compiled({ ...view, compare: { period: { custom: { from: '2025-07-01', to: '2025-09-30' } } } });
    expect(out.comparison).toEqual({ from: '2025-07-01', to: '2025-10-01' });
    expect(out.sql).toContain(`(${now}) AS "__cur", ("sale_date" >= DATE '2025-07-01' AND "sale_date" < DATE '2025-10-01') AS "__prev"`);
    expect(out.columns.find((c) => c.name === 'prev__sales')).toMatchObject({
      label: 'Sales Comparison', part: 'previous', period: { from: '2025-07-01', to: '2025-10-01', days: 92 },
    });
    expect(out.months).toEqual({ from: '2025-07', to: '2026-11' });
  });

  it('reads the months of a comparison window that comes after the period', () => {
    const out = compiled({ ...view, period: { custom: { from: '2025-11-01', to: '2025-11-30' } }, compare: { period: { preset: 'current_month' } } });
    expect(out.window).toEqual({ from: '2025-11-01', to: '2025-12-01' });
    expect(out.comparison).toEqual({ from: '2026-11-01', to: '2026-12-01' });
    expect(out.months).toEqual({ from: '2025-11', to: '2026-11' });
  });

  it.each([
    [{ compare: {} }, 'option_unsupported'],
    [{ compare: { period: 'last year' } }, 'option_unsupported'],
    [{ compare: { period: { named: 'nope' } } }, 'unknown_period'],
    [{ compare: { period: { custom: { from: '2025-02-30', to: '2025-03-01' } } } }, 'bad_date'],
  ])('refuses the comparison %j with %s', (change, reason) => {
    expect(refusal({ ...view, ...change })).toBe(reason);
  });
});

describe('compileView, filters on a measure', () => {
  it('drops rows after grouping and never the total row', () => {
    const { sql } = compiled({ options: { total_row: true }, filters: { op: 'and', rules: [{ measure: 'sales', cmp: '>=', value: 1000 }] } });
    expect(sql).toContain('FROM g\nWHERE "__total" = 1 OR ("m__sales" >= 1000)\n)');
  });

  it('computes a measure the view does not show, and leaves it out of the result', () => {
    const out = compiled({ filters: { op: 'and', rules: [{ measure: 'gp', cmp: '<', value: 0.2 }] } });
    expect(out.sql).toContain(' AS "m__gp", 0 AS "__total"');
    expect(out.sql).toContain('SELECT * EXCLUDE ("__rn", "m__gp") FROM r');
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'm__sales', '__total', '__rows']);
  });

  it('splits a mixed "and" into a condition on fact rows and one on grouped rows', () => {
    const { sql } = compiled({ filters: { op: 'and', rules: [
      { dimension: 'branch', cmp: 'in', values: ['1'] },
      { op: 'or', rules: [{ measure: 'sales', cmp: '>', value: 500 }, { measure: 'qty', cmp: '=', value: 0 }] },
    ] } });
    expect(sql).toContain('WHERE (CAST(f."branch_code" AS VARCHAR) IN (\'1\'))\nGROUP BY f."branch_code"');
    expect(sql).toContain('WHERE "__total" = 1 OR (("m__sales" > 500 OR "m__qty" = 0))');
    expect(sql).toContain('SELECT * EXCLUDE ("__rn", "m__qty") FROM r');
  });
});

describe('compileView, transaction mode', () => {
  const view = { mode: 'transaction', measures: ['sales', 'lines'], path: [{ dimension: 'branch', selected: ['1'] }] };

  it('lists the fact rows, newest first, in an order that is the same on every page', () => {
    const out = compiled(view);
    expect(out.sql).toBe([
      'WITH g AS (',
      'SELECT CAST(CAST(f."sale_date" AS DATE) AS VARCHAR) AS "date", f."product_code" AS "dim__product", f."branch_code" AS "dim__branch", f."doc_no" AS "col__doc", CAST(f."amount" AS DOUBLE) AS "m__sales", CAST(1 AS DOUBLE) AS "m__lines"',
      'FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'WHERE CAST(f."branch_code" AS VARCHAR) IN (\'1\')',
      '), r AS (',
      'SELECT g.*, row_number() OVER (ORDER BY "date" DESC NULLS LAST, "dim__product" ASC, "dim__branch" ASC, "col__doc" ASC, "m__sales" ASC, "m__lines" ASC) AS "__rn",',
      'CAST(count(*) OVER () AS INTEGER) AS "__rows"',
      'FROM g',
      ')',
      'SELECT * EXCLUDE ("__rn") FROM r',
      'WHERE "__rn" > 0 AND "__rn" <= 200',
      'ORDER BY "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'date:date', 'dimension:dim__product', 'dimension:dim__branch', 'column:col__doc', 'measure:m__sales', 'measure:m__lines', 'meta:__rows',
    ]);
  });

  it('works a formula out on each row from that row\'s own values', () => {
    expect(compiled({ ...view, measures: ['gp'] }).sql).toContain('/ NULLIF((f."amount"), 0)) AS DOUBLE) AS "m__gp"');
  });

  it('lists only the extra columns it is asked for', () => {
    const out = compiled({ ...view, columns: [] });
    expect(out.sql).not.toContain('"col__doc"');
    expect(out.columns.some((c) => c.kind === 'column')).toBe(false);
  });

  it('sorts by a dimension and pages', () => {
    const { sql } = compiled({ ...view, sort: { by: 'dimension.product', dir: 'asc' }, limit: 50, offset: 100 });
    expect(sql).toContain('ORDER BY "dim__product" ASC NULLS LAST, "date" ASC, "dim__branch" ASC');
    expect(sql).toContain('WHERE "__rn" > 100 AND "__rn" <= 150');
  });

  it('filters through a lookup table like any other mode', () => {
    const { sql } = compiled({ ...view, path: [{ dimension: 'department', selected: ['010'] }] });
    expect(sql).toContain('LEFT JOIN "products" AS "d_product" ON "d_product"."code" = f."product_code"');
    expect(sql).toContain('WHERE CAST("d_product"."dept" AS VARCHAR) IN (\'010\')');
  });
});

describe('compileView, the activity option', () => {
  const view = { group_by: 'product', properties: ['name'], measures: ['sales', 'lines'] };

  it('joins the filtered fact rows to the dimension\'s own table and keeps both sides under "all"', () => {
    const { sql } = compiled({ ...view, options: { activity: 'all', total_row: true }, path: [{ dimension: 'branch', selected: ['1'] }] });
    expect(sql).toContain([
      'FROM "products" AS "mb"',
      'FULL JOIN (',
      'SELECT f.*, f."product_code" AS "__code", 1 AS "__in"',
      'FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'WHERE CAST(f."branch_code" AS VARCHAR) IN (\'1\')',
      ') AS f ON f."__code" = "mb"."code"',
      'GROUP BY GROUPING SETS ((COALESCE("mb"."code", f."__code")), ())',
    ].join('\n'));
    expect(sql).toContain('SELECT COALESCE("mb"."code", f."__code") AS "code", CASE WHEN GROUPING(COALESCE("mb"."code", f."__code")) = 0 THEN any_value("mb"."name") END AS "prop__name"');
  });

  it('does not count the row a member with no fact rows has in the join', () => {
    expect(compiled({ ...view, options: { activity: 'all' } }).sql).toContain('CAST(COUNT(f."__in") AS DOUBLE) AS "m__lines"');
    expect(compiled(view).sql).toContain('CAST(COUNT(*) AS DOUBLE) AS "m__lines"');
  });

  it('lists only the members no fact row matched under "without", with no total row', () => {
    const { sql } = compiled({ ...view, options: { activity: 'without', total_row: true } });
    expect(sql).toContain('LEFT JOIN (');
    expect(sql).toContain('GROUP BY COALESCE("mb"."code", f."__code")\nHAVING COUNT(f."__in") = 0\n), r AS (');
    expect(sql).toContain('0 AS "__total"');
  });

  it('narrows the member list by the keyword and by the filters the member\'s table can answer', () => {
    const { sql } = compiled({
      ...view,
      options: { activity: 'without' },
      keyword: 'mug',
      filters: { op: 'and', rules: [
        { dimension: 'department', property: 'name', cmp: 'in', values: ['Gifts'] },
        { dimension: 'branch', cmp: 'in', values: ['1'] },
      ] },
    });
    expect(sql).toContain('LEFT JOIN "departments" AS "mb_department" ON "mb_department"."code" = "mb"."dept"');
    expect(sql).toContain('WHERE f."__in" IS NOT NULL OR ((CAST("mb_department"."name" AS VARCHAR) IN (\'Gifts\')) AND (CAST("mb"."code" AS VARCHAR) ILIKE \'%mug%\' ESCAPE \'\\\' OR "mb"."name" ILIKE \'%mug%\' ESCAPE \'\\\'))');
  });

  it('leaves the member list open when an "or" holds a rule the member\'s table cannot answer', () => {
    const { sql } = compiled({ ...view, options: { activity: 'all' }, filters: { op: 'or', rules: [
      { dimension: 'product', property: 'brand', cmp: 'in', values: ['Acme'] },
      { dimension: 'branch', cmp: 'in', values: ['1'] },
    ] } });
    expect(sql).not.toContain('"__in" IS NOT NULL OR');
  });
});

describe('compileView, snapshot measures', () => {
  it('reads the latest day of the period, found before any filter narrows the rows', () => {
    const { sql } = compiled({ measures: ['soh', 'sales'], path: [{ dimension: 'branch', selected: ['1'] }] });
    expect(sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__lastw") AS DOUBLE) AS "m__soh"');
    expect(sql).toContain('FROM (SELECT *, ("sale_date" = MAX("sale_date") OVER ()) AS "__lastw" FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS s) AS f');
    expect(sql).toContain('CAST(SUM(f."amount") AS DOUBLE) AS "m__sales"');
  });

  it('reads the latest day of each period column', () => {
    const { sql } = compiled({ mode: 'period', measures: ['soh'], period: { preset: 'rolling_3' } });
    expect(sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__b" = 2 AND f."__last") AS DOUBLE) AS "b2__soh"');
    expect(sql).toContain('("sale_date" = MAX("sale_date") OVER (PARTITION BY "__b")) AS "__last", ("sale_date" = MAX("sale_date") OVER ()) AS "__lastw" FROM (SELECT *, CASE WHEN');
  });

  it('reads the latest day of each window in a variance', () => {
    const { sql } = compiled({ mode: 'variance', measures: ['soh'] });
    expect(sql).toContain('("__cur" AND "sale_date" = MAX("sale_date") FILTER (WHERE "__cur") OVER ()) AS "__lastc", ("__prev" AND "sale_date" = MAX("sale_date") FILTER (WHERE "__prev") OVER ()) AS "__lastp"');
    expect(sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__lastp") AS DOUBLE) AS "prev__soh"');
  });

  it('adds nothing to a view with no snapshot measure', () => {
    expect(compiled().sql).not.toContain('__lastw');
  });
});

describe('compileView, stream mode', () => {
  const streams = { mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'] };
  const NOVEMBER = '>= DATE \'2026-11-01\' AND';

  it('groups each stream in its own stage and folds them to one row per member', () => {
    const out = compiled({ ...streams, properties: ['name'], options: { total_row: true } });
    expect(out.sql).toBe([
      'WITH s1 AS (',
      'SELECT f."product_code" AS "code", CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "prop__name", SUM(f."amount") AS "a__sales", CAST(GROUPING(f."product_code") AS INTEGER) AS "__total"',
      'FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'LEFT JOIN "products" AS "d_product" ON "d_product"."code" = f."product_code"',
      'GROUP BY GROUPING SETS ((f."product_code"), ())',
      '), s2 AS (',
      'SELECT f."product_code" AS "code", CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "prop__name", SUM(f."amount") AS "a__ordered", CAST(GROUPING(f."product_code") AS INTEGER) AS "__total"',
      'FROM (SELECT * FROM "order_lines" WHERE "order_date" >= DATE \'2026-11-01\' AND "order_date" < DATE \'2026-12-01\') AS f',
      'LEFT JOIN "products" AS "d_product" ON "d_product"."code" = f."product_code"',
      'GROUP BY GROUPING SETS ((f."product_code"), ())',
      '), g AS (',
      'SELECT "code", any_value("prop__name") AS "prop__name", CAST(any_value("a__sales") AS DOUBLE) AS "m__sales", CAST(any_value("a__ordered") AS DOUBLE) AS "m__ordered", "__total"',
      'FROM (SELECT * FROM s1 UNION ALL BY NAME SELECT * FROM s2) AS u',
      'GROUP BY "code", "__total"',
      '), r AS (',
      'SELECT g.*, row_number() OVER (PARTITION BY "__total" ORDER BY "m__sales" DESC NULLS LAST, "code" ASC) AS "__rn",',
      'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
      'FROM g',
      ')',
      'SELECT * EXCLUDE ("__rn") FROM r',
      'WHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)',
      'ORDER BY "__total" DESC, "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'prop__name', 'm__sales', 'm__ordered', '__total', '__rows']);
    expect(out.streams).toEqual(['sales', 'orders']);
    expect(out.months).toEqual({ from: '2026-11', to: '2026-11' });
  });

  it('works a formula out from the folded sums of two streams', () => {
    const { sql } = compiled({ ...streams, measures: ['fill'] });
    expect(sql).toContain('CAST(((any_value("a__sales")) / NULLIF((any_value("a__ordered")), 0)) AS DOUBLE) AS "m__fill", "__total"');
    expect(sql).toContain('SUM(f."amount") AS "a__sales", 0 AS "__total"');
    expect(sql).toContain('SUM(f."amount") AS "a__ordered", 0 AS "__total"');
  });

  it('writes each sum once, however many formulas read it', () => {
    const { sql } = compiled({ ...streams, measures: ['gp', 'profit', 'sales', 'ordered'] });
    expect(sql).toContain('SELECT f."product_code" AS "code", SUM(f."amount") AS "a__sales", SUM(f."cost") AS "a__cost", 0 AS "__total"');
  });

  it('applies the drill path to every stream', () => {
    const { sql } = compiled({ ...streams, path: [{ dimension: 'product', selected: ['P1'] }] });
    expect(sql.split('WHERE CAST(f."product_code" AS VARCHAR) IN (\'P1\')\nGROUP BY f."product_code"')).toHaveLength(3);
  });

  it('reads a snapshot measure on its own stream\'s latest day', () => {
    const { sql } = compiled({ ...streams, measures: ['soh', 'ordered'] });
    expect(sql).toContain('SUM(f."qty") FILTER (WHERE f."__lastw") AS "a__soh"');
    expect(sql).toContain(`FROM (SELECT *, ("sale_date" = MAX("sale_date") OVER ()) AS "__lastw" FROM (SELECT * FROM "sales_lines" WHERE "sale_date" ${NOVEMBER}`);
    expect(sql).toContain(`FROM (SELECT * FROM "order_lines" WHERE "order_date" ${NOVEMBER}`);
  });

  it('filters on a measure of another stream without showing it', () => {
    const out = compiled({ ...streams, measures: ['sales'], filters: { op: 'and', rules: [{ measure: 'ordered', cmp: '>', value: 0 }] } });
    expect(out.sql).toContain('), s2 AS (');
    expect(out.sql).toContain('CAST(any_value("a__ordered") AS DOUBLE) AS "m__ordered", "__total"');
    expect(out.sql).toContain('FROM g\nWHERE "__total" = 1 OR ("m__ordered" > 0)\n)');
    expect(out.sql).toContain('SELECT * EXCLUDE ("__rn", "m__ordered") FROM r');
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'm__sales', '__total', '__rows']);
  });

  it('always reads the view\'s own stream, and no other one its measures do not need', () => {
    const one = compiled({ ...streams, group_by: 'branch', measures: ['sales'] });
    expect(one.sql).toContain('FROM (SELECT * FROM s1) AS u');
    expect(one.sql).not.toContain('s2 AS (');
    expect(one.streams).toEqual(['sales']);
    const other = compiled({ ...streams, measures: ['ordered'] });
    expect(other.sql).toContain('SELECT f."product_code" AS "code", 0 AS "__total"\nFROM (SELECT * FROM "sales_lines"');
    expect(other.streams).toEqual(['sales', 'orders']);
  });

  it('sorts by a property', () => {
    const { sql } = compiled({ ...streams, properties: ['name'], sort: { by: 'property.name', dir: 'asc' } });
    expect(sql).toContain('ORDER BY "prop__name" ASC NULLS LAST, "code" ASC');
  });
});

describe('compileView, matrix mode', () => {
  const matrix = { mode: 'matrix', across: { dimension: 'product' } };

  it('groups cells, row totals, column totals and the grand total in one pass, and returns one row per cell', () => {
    const out = compiled(matrix);
    expect(out.sql).toBe([
      'WITH g AS (',
      'SELECT f."branch_code" AS "code", f."product_code" AS "across", CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "across__name", CAST(SUM(f."amount") AS DOUBLE) AS "m__sales", CAST(GROUPING(f."branch_code") AS INTEGER) AS "__total", CAST(GROUPING(f."product_code") AS INTEGER) AS "__across_total"',
      'FROM (SELECT * FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'LEFT JOIN "products" AS "d_product" ON "d_product"."code" = f."product_code"',
      'GROUP BY GROUPING SETS ((f."branch_code", f."product_code"), (f."branch_code"), (f."product_code"), ())',
      '), rw AS (',
      'SELECT "code", row_number() OVER (ORDER BY "m__sales" DESC NULLS LAST, "code" ASC) AS "__row"',
      'FROM g',
      'WHERE "__total" = 0 AND "__across_total" = 1',
      '), cl AS (',
      'SELECT "across", row_number() OVER (ORDER BY "m__sales" DESC NULLS LAST, "across" ASC) AS "__col"',
      'FROM g',
      'WHERE "__total" = 1 AND "__across_total" = 0',
      ')',
      'SELECT g.*, COALESCE(rw."__row", 0) AS "__row", COALESCE(cl."__col", 0) AS "__col",',
      'CAST((SELECT count(*) FROM rw) AS INTEGER) AS "__rows", CAST((SELECT count(*) FROM cl) AS INTEGER) AS "__cols"',
      'FROM g',
      'LEFT JOIN rw ON g."__total" = 0 AND rw."code" IS NOT DISTINCT FROM g."code"',
      'LEFT JOIN cl ON g."__across_total" = 0 AND cl."across" IS NOT DISTINCT FROM g."across"',
      'WHERE ((g."__total" = 1 AND g."__across_total" = 0) OR (rw."__row" > 0 AND rw."__row" <= 152)) AND (g."__across_total" = 1 OR cl."__col" <= 12)',
      'ORDER BY g."__total" DESC, rw."__row" ASC, g."__across_total" DESC, cl."__col" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'across', 'across__name', 'm__sales', '__total', '__across_total', '__row', '__col', '__rows', '__cols']);
    expect(out.across).toEqual({ dimension: 'product', limit: 12 });
  });

  it('keeps the column totals when asked, and the columns and page it is given', () => {
    const out = compiled({ ...matrix, across: { dimension: 'product', limit: 3, order: 'code' }, limit: 10, offset: 20, options: { total_row: true } });
    expect(out.sql).toContain('SELECT "across", row_number() OVER (ORDER BY "across" ASC) AS "__col"');
    expect(out.sql).toContain('WHERE (g."__total" = 1 OR (rw."__row" > 20 AND rw."__row" <= 30)) AND (g."__across_total" = 1 OR cl."__col" <= 3)');
    expect(out.across).toEqual({ dimension: 'product', limit: 3 });
  });

  it('fits a page to the result rows it may return', () => {
    const wide = compileView(fixtureModel(), { ...base, ...matrix } as ViewState, { today: TODAY, maxRows: Number.POSITIVE_INFINITY });
    expect(wide.ok ? wide.sql : wide.reason).toContain('rw."__row" <= 200)) AND');
  });

  it('filters rows on their totals, and can read a measure it does not show', () => {
    const out = compiled({ ...matrix, filters: { op: 'and', rules: [{ measure: 'qty', cmp: '>', value: 5 }] } });
    expect(out.sql).toContain('WHERE "__total" = 0 AND "__across_total" = 1 AND ("m__qty" > 5)\n), cl AS (');
    expect(out.sql).toContain('SELECT g.* EXCLUDE ("m__qty"), COALESCE(rw."__row", 0) AS "__row"');
    expect(out.columns.map((c) => c.name)).not.toContain('m__qty');
  });

  it('works a formula out at every level from that level\'s own sums', () => {
    const { sql } = compiled({ ...matrix, measures: ['gp'] });
    expect(sql).toContain('CAST(((((SUM(f."amount")) - (SUM(f."cost")))) / NULLIF((SUM(f."amount")), 0)) AS DOUBLE) AS "m__gp"');
  });

  it('shows row properties, sorts by one, and names the columns only when their dimension has names', () => {
    const out = compiled({ ...matrix, group_by: 'product', across: { dimension: 'branch' }, properties: ['name'], sort: { by: 'property.name', dir: 'asc' } });
    expect(out.sql).toContain('SELECT f."product_code" AS "code", CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "prop__name", f."branch_code" AS "across", CAST(SUM(f."amount") AS DOUBLE) AS "m__sales"');
    expect(out.sql).toContain('ORDER BY "prop__name" ASC NULLS LAST, "code" ASC) AS "__row"');
    expect(out.columns.map((c) => c.name).slice(0, 4)).toEqual(['code', 'prop__name', 'across', 'm__sales']);
  });

  it('reads a snapshot measure on the latest day of the period', () => {
    const { sql } = compiled({ ...matrix, measures: ['soh'] });
    expect(sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__lastw") AS DOUBLE) AS "m__soh"');
    expect(sql).toContain('FROM (SELECT *, ("sale_date" = MAX("sale_date") OVER ()) AS "__lastw" FROM (SELECT * FROM "sales_lines" WHERE');
  });
});

describe('compileView, the long shape of a period view', () => {
  const view = { mode: 'period', period: { preset: 'rolling_3' } };
  const long = { periodShape: 'long' as const };

  it('returns one row per member and period, with the periods as the columns of a matrix', () => {
    const out = compiled(view, long);
    expect(out.sql).toBe([
      'WITH g AS (',
      'SELECT f."branch_code" AS "code", f."__b" AS "across", CAST(SUM(f."amount") AS DOUBLE) AS "m__sales", CAST(GROUPING(f."branch_code") AS INTEGER) AS "__total", CAST(GROUPING(f."__b") AS INTEGER) AS "__across_total"',
      'FROM (SELECT *, CASE WHEN "sale_date" < DATE \'2026-10-01\' THEN 1 WHEN "sale_date" < DATE \'2026-11-01\' THEN 2 WHEN "sale_date" < DATE \'2026-12-01\' THEN 3 END AS "__b" FROM "sales_lines" WHERE "sale_date" >= DATE \'2026-09-01\' AND "sale_date" < DATE \'2026-12-01\') AS f',
      'GROUP BY GROUPING SETS ((f."branch_code", f."__b"), (f."branch_code"), (f."__b"), ())',
      '), rw AS (',
      'SELECT "code", row_number() OVER (ORDER BY "m__sales" DESC NULLS LAST, "code" ASC) AS "__row"',
      'FROM g',
      'WHERE "__total" = 0 AND "__across_total" = 1',
      '), cl AS (',
      'SELECT "across", "across" AS "__col"',
      'FROM g',
      'WHERE "__total" = 1 AND "__across_total" = 0',
      ')',
      'SELECT g.*, COALESCE(rw."__row", 0) AS "__row", COALESCE(cl."__col", 0) AS "__col",',
      'CAST((SELECT count(*) FROM rw) AS INTEGER) AS "__rows", 3 AS "__cols"',
      'FROM g',
      'LEFT JOIN rw ON g."__total" = 0 AND rw."code" IS NOT DISTINCT FROM g."code"',
      'LEFT JOIN cl ON g."__across_total" = 0 AND cl."across" IS NOT DISTINCT FROM g."across"',
      'WHERE rw."__row" > 0 AND rw."__row" <= 200 AND (g."__across_total" = 1 OR cl."__col" <= 3)',
      'ORDER BY g."__total" DESC, rw."__row" ASC, g."__across_total" DESC, cl."__col" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'across', 'm__sales', '__total', '__across_total', '__row', '__col', '__rows', '__cols']);
    expect(out.shape).toBe('long');
    expect(out.buckets.map((b) => b.label)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);
    expect(out.across).toBeUndefined();
  });

  it('stays one column per period while that statement fits, and goes long by itself when it does not', () => {
    const wide = { mode: 'period', period: { preset: 'rolling_12' }, measures: ['sales', 'cost', 'qty', 'gp'] };
    expect(compiled(wide).shape).toBeUndefined();
    const out = compiled(wide, { maxSqlChars: 4000 });
    expect(out.shape).toBe('long');
    expect(out.sql).toContain('GROUP BY GROUPING SETS ((f."branch_code", f."__b"), (f."branch_code"), (f."__b"), ())');
    expect(out.limit).toBe(153);
    expect(refusal(wide, { maxSqlChars: 4000, periodShape: 'wide' })).toBe('sql_too_long');
  });

  it('reports the first refusal when the long shape cannot take the view either', () => {
    const view2 = { mode: 'period', period: { preset: 'rolling_12' }, measures: ['sales', 'cost', 'qty', 'gp'], group_by: 'product', options: { activity: 'all' } };
    expect(refusal(view2, { maxSqlChars: 4000 })).toBe('sql_too_long');
    expect(refusal(view2, long)).toBe('option_unsupported');
  });

  it('gives DAYS() the days of the period on a cell and of the whole window on a total', () => {
    const { sql } = compiled({ ...view, measures: ['daily'] }, long);
    expect(sql).toContain('CAST(((SUM(f."amount")) / NULLIF((CASE WHEN GROUPING(f."__b") = 0 THEN any_value(f."__days") ELSE 91 END), 0)) AS DOUBLE) AS "m__daily"');
    expect(sql).toContain('END AS "__b", CASE WHEN "sale_date" < DATE \'2026-10-01\' THEN 30 WHEN "sale_date" < DATE \'2026-11-01\' THEN 31 WHEN "sale_date" < DATE \'2026-12-01\' THEN 30 END AS "__days" FROM "sales_lines"');
  });

  it('reads a snapshot measure on the latest day of the period on a cell, and of the window on a total', () => {
    const { sql } = compiled({ ...view, measures: ['soh'] }, long);
    expect(sql).toContain('CAST(CASE WHEN GROUPING(f."__b") = 0 THEN SUM(f."qty") FILTER (WHERE f."__last") ELSE SUM(f."qty") FILTER (WHERE f."__lastw") END AS DOUBLE) AS "m__soh"');
    expect(sql).toContain('FROM (SELECT *, ("sale_date" = MAX("sale_date") OVER (PARTITION BY "__b")) AS "__last", ("sale_date" = MAX("sale_date") OVER ()) AS "__lastw" FROM (SELECT *, CASE WHEN');
  });

  it('sorts rows by one period of one measure, and numbers the periods newest first when reversed', () => {
    const out = compiled({ ...view, sort: { by: 'period.2.sales', dir: 'asc' }, options: { reverse_periods: true, total_row: true } }, long);
    expect(out.sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__b" = 2) AS DOUBLE) AS "__sort", CAST(GROUPING(f."branch_code") AS INTEGER) AS "__total"');
    expect(out.sql).toContain('ORDER BY "__sort" ASC NULLS LAST, "code" ASC) AS "__row"');
    expect(out.sql).toContain('SELECT g.* EXCLUDE ("__sort"), COALESCE(rw."__row", 0) AS "__row"');
    expect(out.sql).toContain('SELECT "across", 4 - "across" AS "__col"');
    expect(out.sql).toContain('WHERE (g."__total" = 1 OR (rw."__row" > 0 AND rw."__row" <= 200)) AND');
    expect(refusal({ ...view, sort: { by: 'period.9.sales', dir: 'asc' } }, long)).toBe('bad_sort');
  });
});

describe('compileView, others and average rows', () => {
  const focus = { group_by: 'product', path: [{ dimension: 'product', selected: ['P1', 'P2'] }] };

  it('adds an average row: the mean of each measure column over every row of the list', () => {
    const out = compiled({ options: { average_row: true } });
    expect(out.sql).toContain([
      'FROM g',
      '), a AS (',
      'SELECT avg("m__sales") AS "m__sales", 3 AS "__total", 0 AS "__rn", CAST(count(*) AS INTEGER) AS "__rows"',
      'FROM r',
      'WHERE "__total" = 0',
      ')',
      'SELECT * EXCLUDE ("__rn") FROM (',
      'SELECT * FROM r',
      'WHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)',
      'UNION ALL BY NAME',
      'SELECT * FROM a',
      ') AS p',
      'ORDER BY "__total" DESC, "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'm__sales', '__total', '__rows']);
  });

  it('averages every column of a variance, after a measure filter has dropped rows', () => {
    const { sql } = compiled({
      mode: 'variance',
      options: { average_row: true },
      filters: { op: 'and', rules: [{ measure: 'sales', cmp: '>', value: 10 }] },
    });
    expect(sql).toContain('FROM v\nWHERE "__total" = 1 OR ("m__sales" > 10)\n), a AS (');
    expect(sql).toContain('SELECT avg("m__sales") AS "m__sales", avg("prev__sales") AS "prev__sales", avg("var__sales") AS "var__sales", avg("varp__sales") AS "varp__sales", 3 AS "__total"');
  });

  it('adds an others row: the members the focus on the group-by dimension leaves out', () => {
    const out = compiled({ ...focus, properties: ['name'], options: { others_row: true, total_row: true } });
    expect(out.sql).toContain('CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "prop__name"');
    expect(out.sql).toContain('COALESCE(CAST(f."product_code" AS VARCHAR) IN (\'P1\', \'P2\'), FALSE) AS "__f", CASE WHEN GROUPING(f."product_code") = 0 THEN 0 WHEN "__f" THEN 1 ELSE 2 END AS "__total"');
    expect(out.sql).toContain('GROUP BY GROUPING SETS ((f."product_code", "__f"), ("__f"))\nHAVING GROUPING(f."product_code") = 1 OR "__f"\n), r AS (');
    expect(out.sql).not.toContain('WHERE CAST(f."product_code" AS VARCHAR) IN');
    expect(out.sql).toContain('SELECT * EXCLUDE ("__rn", "__f") FROM r\nWHERE "__total" > 0 OR ("__rn" > 0 AND "__rn" <= 200)');
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'prop__name', 'm__sales', '__total', '__rows']);
  });

  it('keeps the others row and drops the total when the total row is off, and under a measure filter', () => {
    const { sql } = compiled({ ...focus, options: { others_row: true }, filters: { op: 'and', rules: [{ measure: 'sales', cmp: '>', value: 10 }] } });
    expect(sql).toContain('HAVING "__f" = (GROUPING(f."product_code") = 0)\n), r AS (');
    expect(sql).toContain('FROM g\nWHERE "__total" > 0 OR ("m__sales" > 10)\n)');
  });

  it('has no others row without a focus, and a step on another dimension is not one', () => {
    expect(compiled({ options: { others_row: true } }).sql).toBe(compiled().sql);
    const step = { path: [{ dimension: 'product', selected: ['P1'] }] };
    expect(compiled({ ...step, options: { others_row: true } }).sql).toBe(compiled(step).sql);
  });

  it('counts the extra rows against the page', () => {
    expect(refusal({ limit: 1999, options: { total_row: true, average_row: true } })).toBe('bad_paging');
    expect(compiled({ limit: 1998, options: { total_row: true, average_row: true } }).sql).toContain('"__rn" <= 1998)');
    expect(refusal({ ...focus, limit: 1998, options: { total_row: true, average_row: true, others_row: true } })).toBe('bad_paging');
  });
});

describe('compileView, the average column and hiding zero rows', () => {
  const periods = { mode: 'period', period: { preset: 'rolling_3' } };
  const ZERO = 'COALESCE("m__sales", 0) <> 0';

  it('adds one column a measure in period mode: the mean of its period columns, read from the row itself', () => {
    const out = compiled({ ...periods, options: { average_column: true } });
    expect(out.sql).toContain('), v AS (\nSELECT g.*, list_avg(["b1__sales", "b2__sales", "b3__sales"]) AS "avg__sales"\nFROM g\n), r AS (');
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'b1__sales', 'b2__sales', 'b3__sales', 'm__sales', 'avg__sales', '__total', '__rows']);
    expect(out.columns.find((c) => c.name === 'avg__sales')).toEqual(
      { name: 'avg__sales', kind: 'measure', measure: 'sales', format: 'currency', label: 'Sales Average', period: null, average: true },
    );
  });

  it('sorts by the average column, and averages it on an average row', () => {
    const sorted = compiled({ ...periods, sort: { by: 'average.sales', dir: 'asc' }, options: { average_column: true } });
    expect(sorted.sql).toContain('ORDER BY "avg__sales" ASC NULLS LAST, "code" ASC');
    const both = compiled({ ...periods, options: { average_column: true, average_row: true } });
    expect(both.sql).toContain('avg("m__sales") AS "m__sales", avg("avg__sales") AS "avg__sales", 3 AS "__total"');
  });

  it('keeps the oldest-first names in the average when the period columns are shown newest first', () => {
    const out = compiled({ ...periods, options: { average_column: true, reverse_periods: true } });
    expect(out.sql).toContain('list_avg(["b1__sales", "b2__sales", "b3__sales"]) AS "avg__sales"');
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'b3__sales', 'b2__sales', 'b1__sales', 'm__sales', 'avg__sales', '__total', '__rows']);
  });

  it('has no average column outside period mode, and refuses it in the long shape', () => {
    expect(compiled({ options: { average_column: true } }).sql).toBe(compiled().sql);
    expect(refusal({ sort: { by: 'average.sales', dir: 'asc' }, options: { average_column: true } })).toBe('bad_sort');
    expect(refusal({ ...periods, options: { average_column: true } }, { periodShape: 'long' })).toBe('option_unsupported');
  });

  it('hides the rows whose shown figures are all zero or blank, and never the total row', () => {
    const one = compiled({ options: { hide_zero_rows: true, total_row: true } });
    expect(one.sql).toContain(`FROM g\nWHERE "__total" = 1 OR (${ZERO})\n)`);
    const two = compiled({ measures: ['sales', 'qty'], options: { hide_zero_rows: true } });
    expect(two.sql).toContain(`FROM g\nWHERE "__total" = 1 OR (${ZERO} OR COALESCE("m__qty", 0) <> 0)\n)`);
  });

  it('applies with a filter on a measure, and judges a variance on both of its windows', () => {
    const filtered = compiled({ options: { hide_zero_rows: true }, filters: { op: 'and', rules: [{ measure: 'sales', cmp: '>', value: 10 }] } });
    expect(filtered.sql).toContain(`FROM g\nWHERE "__total" = 1 OR ((${ZERO}) AND ("m__sales" > 10))\n)`);
    const variance = compiled({ mode: 'variance', options: { hide_zero_rows: true } });
    expect(variance.sql).toContain(`FROM v\nWHERE "__total" = 1 OR (${ZERO} OR COALESCE("prev__sales", 0) <> 0)\n)`);
  });

  it('hides zero rows in stream and matrix modes and in the long shape, by the row totals', () => {
    const streams = compiled({ mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'], options: { hide_zero_rows: true } });
    expect(streams.sql).toContain(`FROM g\nWHERE "__total" = 1 OR (${ZERO} OR COALESCE("m__ordered", 0) <> 0)\n)`);
    const matrix = compiled({ mode: 'matrix', across: { dimension: 'product' }, options: { hide_zero_rows: true } });
    expect(matrix.sql).toContain(`FROM g\nWHERE "__total" = 0 AND "__across_total" = 1 AND (${ZERO})\n), cl AS (`);
    const long = compiled({ ...periods, options: { hide_zero_rows: true } }, { periodShape: 'long' });
    expect(long.sql).toContain(`FROM g\nWHERE "__total" = 0 AND "__across_total" = 1 AND (${ZERO})\n), cl AS (`);
  });

  it('refuses hiding zero rows with the activity option, and a transaction list ignores it', () => {
    expect(refusal({ group_by: 'product', options: { hide_zero_rows: true, activity: 'all' } })).toBe('option_unsupported');
    const list = { mode: 'transaction', measures: ['sales'] };
    expect(compiled({ ...list, options: { hide_zero_rows: true } }).sql).toBe(compiled(list).sql);
  });
});

describe('compileView, the sum row', () => {
  const streams = { mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'] };

  it('adds a sum row: each measure column added up over every row of the list', () => {
    const out = compiled({ options: { sum_row: true } });
    expect(out.sql).toContain([
      'FROM g',
      '), sm AS (',
      'SELECT sum("m__sales") AS "m__sales", 4 AS "__total", 0 AS "__rn", CAST(count(*) AS INTEGER) AS "__rows"',
      'FROM r',
      'WHERE "__total" = 0',
      ')',
      'SELECT * EXCLUDE ("__rn") FROM (',
      'SELECT * FROM r',
      'WHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)',
      'UNION ALL BY NAME',
      'SELECT * FROM sm',
      ') AS p',
      'ORDER BY "__total" DESC, "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'm__sales', '__total', '__rows']);
  });

  it('sits beside the average row, each in its own stage over the same rows', () => {
    const { sql } = compiled({ measures: ['sales', 'gp'], options: { sum_row: true, average_row: true } });
    expect(sql).toContain([
      '), a AS (',
      'SELECT avg("m__sales") AS "m__sales", avg("m__gp") AS "m__gp", 3 AS "__total", 0 AS "__rn", CAST(count(*) AS INTEGER) AS "__rows"',
      'FROM r',
      'WHERE "__total" = 0',
      '), sm AS (',
      'SELECT sum("m__sales") AS "m__sales", sum("m__gp") AS "m__gp", 4 AS "__total", 0 AS "__rn", CAST(count(*) AS INTEGER) AS "__rows"',
      'FROM r',
      'WHERE "__total" = 0',
      ')',
    ].join('\n'));
    expect(sql).toContain('UNION ALL BY NAME\nSELECT * FROM a\nUNION ALL BY NAME\nSELECT * FROM sm\n) AS p');
  });

  it('gives stream mode its average and sum rows, over the folded figures', () => {
    const { sql } = compiled({ ...streams, options: { average_row: true, sum_row: true } });
    expect(sql).toContain('FROM g\n), a AS (\nSELECT avg("m__sales") AS "m__sales", avg("m__ordered") AS "m__ordered", 3 AS "__total"');
    expect(sql).toContain('), sm AS (\nSELECT sum("m__sales") AS "m__sales", sum("m__ordered") AS "m__ordered", 4 AS "__total"');
    expect(sql).toContain('SELECT * EXCLUDE ("__rn") FROM (\nSELECT * FROM r\nWHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)');
  });

  it('counts against the page, and is refused where it is not compiled', () => {
    const three = { total_row: true, average_row: true, sum_row: true };
    expect(refusal({ limit: 1998, options: three })).toBe('bad_paging');
    expect(compiled({ limit: 1997, options: three }).sql).toContain('"__rn" <= 1997)');
    expect(refusal({ ...streams, limit: 1998, options: three })).toBe('bad_paging');
    expect(refusal({ ...streams, options: { others_row: true } })).toBe('option_unsupported');
    expect(refusal({ mode: 'matrix', across: { dimension: 'product' }, options: { sum_row: true } })).toBe('option_unsupported');
    expect(refusal({ mode: 'period', period: { preset: 'rolling_3' }, options: { sum_row: true } }, { periodShape: 'long' })).toBe('option_unsupported');
    expect(refusal({ mode: 'transaction', options: { sum_row: true } })).toBe('option_unsupported');
  });
});

describe('compileRollupView', () => {
  const NOVEMBER = 'WHERE "month" >= DATE \'2026-11-01\' AND "month" < DATE \'2026-12-01\') AS f';

  function rolled(change: Record<string, unknown> = {}): CompiledView {
    const out = compileRollupView(fixtureModel(), { ...base, ...change } as ViewState, { today: TODAY });
    if (!out.ok) throw new Error(`refused: ${out.reason}: ${out.detail}`);
    return { ...out, sql: inlineParams(out.sql, out.params) };
  }
  function unrolled(change: Record<string, unknown>): string {
    const out = compileRollupView(fixtureModel(), { ...base, ...change } as ViewState, { today: TODAY });
    return out.ok ? 'did not refuse' : out.reason;
  }

  it('compiles the same statement over the rollup with the fewest dimensions that covers the view', () => {
    const out = rolled();
    expect(out.rollups).toEqual([{ stream: 'sales', rollup: 'by_branch', table: 'sales_month_branch' }]);
    expect(out.sql).toBe(compiled().sql.replace('"sales_lines"', '"sales_month_branch"').replaceAll('"sale_date"', '"month"'));
    expect(out.columns).toEqual(compiled().columns);
  });

  it('moves to a wider rollup for a dimension, a parent dimension or a measure the smaller one lacks', () => {
    const wide = [{ stream: 'sales', rollup: 'by_product_branch', table: 'sales_month_product_branch' }];
    expect(rolled({ group_by: 'product' }).rollups).toEqual(wide);
    expect(rolled({ group_by: 'department' }).rollups).toEqual(wide);
    expect(rolled({ path: [{ dimension: 'product', selected: ['P1'] }] }).rollups).toEqual(wide);
    expect(rolled({ measures: ['qty'] }).rollups).toEqual(wide);
    const gp = rolled({ measures: ['gp'] });
    expect(gp.rollups).toEqual(wide);
    expect(gp.sql).toContain(`FROM (SELECT * FROM "sales_month_product_branch" ${NOVEMBER}`);
  });

  it('adds up a count the rollup holds, and keeps it 0 where no row falls', () => {
    const { sql } = rolled({ mode: 'period', measures: ['lines'], period: { preset: 'rolling_3' } });
    expect(sql).toContain('CAST(COALESCE(SUM(f."line_count") FILTER (WHERE f."__b" = 2), 0) AS DOUBLE) AS "b2__lines"');
    expect(sql).toContain('CAST(COALESCE(SUM(f."line_count"), 0) AS DOUBLE) AS "m__lines"');
    expect(sql).toContain('CASE WHEN "month" < DATE \'2026-10-01\' THEN 1 WHEN "month" < DATE \'2026-11-01\' THEN 2 WHEN "month" < DATE \'2026-12-01\' THEN 3 END AS "__b"');
  });

  it('reads a variance and another stream from their rollups', () => {
    expect(rolled({ mode: 'variance' }).rollups).toEqual([{ stream: 'sales', rollup: 'by_branch', table: 'sales_month_branch' }]);
    expect(rolled({ stream: 'orders', group_by: 'product', measures: ['ordered'] }).rollups).toEqual([{ stream: 'orders', rollup: 'by_product', table: 'orders_month_product' }]);
  });

  it('picks a rollup for each stream a stream view reads', () => {
    const out = rolled({ mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'] });
    expect(out.rollups).toEqual([
      { stream: 'sales', rollup: 'by_product_branch', table: 'sales_month_product_branch' },
      { stream: 'orders', rollup: 'by_product', table: 'orders_month_product' },
    ]);
    expect(out.sql).toContain(`FROM (SELECT * FROM "sales_month_product_branch" ${NOVEMBER}`);
    expect(out.sql).toContain(`FROM (SELECT * FROM "orders_month_product" ${NOVEMBER}`);
    expect(out.streams).toEqual(['sales', 'orders']);
  });

  it('says no rollup answers a snapshot, a transaction list or a part month', () => {
    expect(unrolled({ measures: ['soh'] })).toBe('no_rollup');
    expect(unrolled({ mode: 'transaction' })).toBe('no_rollup');
    expect(unrolled({ options: { period_to_date: true } })).toBe('no_rollup');
    expect(unrolled({ mode: 'period', period: { preset: 'rolling_3' }, options: { period_to_date: true } })).toBe('no_rollup');
  });

  it('refuses a view that does not compile at all with that view\'s own reason', () => {
    expect(unrolled({ group_by: 'customer' })).toBe('dimension_not_on_stream');
    expect(unrolled({ measures: ['nope'] })).toBe('unknown_measure');
  });

  it('leaves compileView reading the fact table', () => {
    expect(compiled().sql).toContain('FROM "sales_lines"');
    expect(compiled().rollups).toBeUndefined();
  });
});

describe('the tables a statement reads', () => {
  it('lists the fact table and each dimension table once, in the order read', () => {
    expect(compiled().tables).toEqual(['sales_lines']);
    expect(compiled({ group_by: 'department', properties: ['name'] }).tables).toEqual(['sales_lines', 'products', 'departments']);
    const streams = compiled({ mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'], properties: ['name'], options: { total_row: true } });
    expect(streams.tables).toEqual(['sales_lines', 'products', 'order_lines']);
  });

  it('lists the member table an activity view reads', () => {
    const out = compiled({ group_by: 'product', properties: ['name'], measures: ['sales', 'lines'], options: { activity: 'all', total_row: true }, path: [{ dimension: 'branch', selected: ['1'] }] });
    expect(out.tables).toEqual(['products', 'sales_lines']);
  });

  it('does not take a table from text a person typed', () => {
    const out = compiled({ group_by: 'product', properties: ['name'], keyword: 'x FROM "departments" y' });
    expect(out.sql).toContain('FROM "departments"');
    expect(out.tables).toEqual(['sales_lines', 'products']);
  });

  it('lists the rollup in place of the fact table', () => {
    const out = compileRollupView(fixtureModel(), { ...base, group_by: 'department', properties: ['name'] } as ViewState, { today: TODAY });
    expect(out.ok ? out.tables : out.reason).toEqual(['sales_month_product_branch', 'products', 'departments']);
  });

  it('reads quoted names after FROM and JOIN, outside string literals', () => {
    expect(tablesIn('SELECT * FROM "t1" AS f LEFT JOIN "t2" AS "d" ON "d"."code" = f."k" JOIN "t1" AS x ON true')).toEqual(['t1', 't2']);
    expect(tablesIn('WITH g AS (SELECT * FROM "t1" WHERE n = \'it\'\'s FROM "t2"\' AND m IS NOT DISTINCT FROM g."code") SELECT * FROM g')).toEqual(['t1']);
  });

  it('gives its stages only names a model table cannot have', () => {
    const views = [
      {}, { options: { average_row: true, sum_row: true } }, { mode: 'variance' },
      { mode: 'period', period: { preset: 'rolling_3' }, options: { average_column: true } },
      { mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'] }, { mode: 'matrix', across: { dimension: 'product' } },
    ];
    const names = views.flatMap((view) => [...compiled(view).sql.matchAll(/(?:WITH|\),) (\w+) AS \(/g)].map((m) => m[1] ?? ''));
    expect(names).toEqual(expect.arrayContaining(['g', 'r', 'a', 'sm', 's1', 's2']));
    expect(names.filter((name) => !isStageName(name))).toEqual([]);
    expect(['sales_lines', 'groups', 's', 'sm_2', 'ar'].filter(isStageName)).toEqual([]);
    expect(['S1', 's12', 'G', 'rw'].filter(isStageName)).toEqual(['S1', 's12', 'G', 'rw']);
  });

  it('is read by the route as naming the model tables and nothing else, in every mode', () => {
    // The route's table scan, cut down: a stage is `name AS (`, and any other name after FROM or JOIN is a table the role must hold.
    const routeTables = (sql: string): string[] => {
      const code = sql.replace(/'(?:[^']|'')*'/g, "''");
      const stages = new Set([...code.matchAll(/(?:^|[\s,(])("?[a-z_][a-z0-9_]*"?)\s*(?:\([^)]*\))?\s+as\s*\(/gi)].map((m) => (m[1] ?? '').replace(/"/g, '').toLowerCase()));
      const names = [...code.matchAll(/\b(?:from|join)\s+("?[a-z_][a-z0-9_.]*"?)/gi)]
        .filter((m) => !/\bis\s+(?:not\s+)?distinct\s*$/i.test(code.slice(0, m.index ?? 0)))
        .map((m) => (m[1] ?? '').replace(/"/g, '').toLowerCase().split('.').pop() ?? '');
      return [...new Set(names.filter((name) => !stages.has(name)))].sort();
    };
    const rolling = { preset: 'rolling_3' };
    const cases: Array<[Record<string, unknown>, { periodShape?: 'wide' | 'long' }]> = [
      [{ options: { average_row: true, sum_row: true, total_row: true } }, {}],
      [{ group_by: 'department', properties: ['name'] }, {}],
      [{ group_by: 'product', options: { activity: 'all' } }, {}],
      [{ group_by: 'product', path: [{ dimension: 'product', selected: ['P1'] }], options: { others_row: true } }, {}],
      [{ mode: 'variance', options: { sum_row: true } }, {}],
      [{ mode: 'period', period: rolling, options: { average_column: true } }, {}],
      [{ mode: 'period', period: rolling }, { periodShape: 'long' }],
      [{ mode: 'period_variance', period: rolling }, {}],
      [{ mode: 'stream', group_by: 'product', measures: ['sales', 'ordered'] }, {}],
      [{ mode: 'matrix', across: { dimension: 'product' } }, {}],
      [{ mode: 'transaction', measures: ['sales', 'lines'] }, {}],
      [{ mode: 'custom', custom_columns: [{ key: 'now', point: { measure: 'sales' } }] }, {}],
    ];
    for (const [view, ctx] of cases) {
      const out = compiled(view, ctx);
      expect(routeTables(out.sql), JSON.stringify(view)).toEqual([...out.tables].sort());
    }
  });
});

describe('compileView, custom mode', () => {
  const LAST_YEAR = { custom: { from: '2025-11-01', to: '2025-11-30' } };
  const now = { key: 'now', point: { measure: 'sales' } };
  const custom = (columns: unknown[], more: Record<string, unknown> = {}) => ({ mode: 'custom', custom_columns: columns, ...more });

  it('gives each column its own measure, dates and rule, and reads each data point once', () => {
    const out = compiled(custom([
      now,
      { key: 'ly', point: { measure: 'sales', period: LAST_YEAR } },
      { key: 'diff', point: { measure: 'sales' }, against: { measure: 'sales', period: LAST_YEAR } },
      { key: 'pct', label: 'Growth', point: { measure: 'sales' }, against: { measure: 'sales', period: LAST_YEAR }, show: 'percent' },
      {
        key: 'share', expression: 'a / b * 100', format: 'percent',
        points: { a: { measure: 'sales', where: { dimension: 'product', cmp: 'in', values: ['P1'] } }, b: { measure: 'sales' } },
      },
    ]));
    const thisMonth = '"sale_date" >= DATE \'2026-11-01\' AND "sale_date" < DATE \'2026-12-01\'';
    const lastYear = '"sale_date" >= DATE \'2025-11-01\' AND "sale_date" < DATE \'2025-12-01\'';
    expect(out.sql).toBe([
      'WITH g AS (',
      'SELECT f."branch_code" AS "code", CAST(SUM(f."amount") FILTER (WHERE f."__w1") AS DOUBLE) AS "p1", '
        + 'CAST(SUM(f."amount") FILTER (WHERE f."__w2") AS DOUBLE) AS "p2", '
        + 'CAST(SUM(f."amount") FILTER (WHERE f."__w1" AND CAST(f."product_code" AS VARCHAR) IN (\'P1\')) AS DOUBLE) AS "p3", 0 AS "__total"',
      `FROM (SELECT *, (${thisMonth}) AS "__w1", (${lastYear}) AS "__w2" FROM "sales_lines" WHERE (${thisMonth}) OR (${lastYear})) AS f`,
      'GROUP BY f."branch_code"',
      '), v AS (',
      'SELECT g.*, CAST("p1" AS DOUBLE) AS "c__now", CAST("p2" AS DOUBLE) AS "c__ly", '
        + 'CAST(COALESCE("p1", 0) - COALESCE("p2", 0) AS DOUBLE) AS "c__diff", '
        + 'CAST((COALESCE("p1", 0) - "p2") / NULLIF(abs("p2"), 0) AS DOUBLE) AS "c__pct", '
        + 'CAST(((("p3") / NULLIF(("p1"), 0)) * 100) AS DOUBLE) AS "c__share"',
      'FROM g',
      '), r AS (',
      'SELECT v.*, row_number() OVER (PARTITION BY "__total" ORDER BY "c__now" DESC NULLS LAST, "code" ASC) AS "__rn",',
      'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
      'FROM v',
      ')',
      'SELECT * EXCLUDE ("__rn", "p1", "p2", "p3") FROM r',
      'WHERE "__total" = 1 OR ("__rn" > 0 AND "__rn" <= 200)',
      'ORDER BY "__total" DESC, "__rn" ASC',
    ].join('\n'));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'c__now', 'c__ly', 'c__diff', 'c__pct', 'c__share', '__total', '__rows']);
    expect(out.columns[1]).toMatchObject({ kind: 'measure', custom: 'now', label: 'Sales', measure: 'sales', format: 'currency', period: { from: '2026-11-01', to: '2026-12-01', days: 30, label: '2026-11-01 to 2026-11-30' } });
    expect(out.columns[3]).toMatchObject({ custom: 'diff', label: 'Sales Variance', format: 'currency', period: null });
    expect(out.columns[4]).toMatchObject({ custom: 'pct', label: 'Growth', format: 'percent' });
    expect(out.columns[5]).toEqual({ name: 'c__share', kind: 'measure', custom: 'share', label: 'share', format: 'percent', period: null });
    expect(out.window).toEqual({ from: '2025-11-01', to: '2026-12-01' });
    expect(out.windows).toEqual([{ from: '2026-11-01', to: '2026-12-01' }, { from: '2025-11-01', to: '2025-12-01' }]);
    expect(out.months).toEqual({ from: '2025-11', to: '2026-11' });
    expect(out.buckets).toEqual([]);
  });

  it('leaves a hidden column out of the result and still sorts by it', () => {
    const out = compiled(custom(
      [{ key: 'a', point: { measure: 'sales' }, hidden: true }, { key: 'b', point: { measure: 'qty' } }],
      { sort: { by: 'column.a', dir: 'asc' } },
    ));
    expect(out.columns.map((c) => c.name)).toEqual(['code', 'c__b', '__total', '__rows']);
    expect(out.sql).toContain('ORDER BY "c__a" ASC NULLS LAST, "code" ASC');
    expect(out.sql).toContain('SELECT * EXCLUDE ("__rn", "c__a", "p1", "p2") FROM r');
    const unsorted = compiled(custom([{ key: 'a', point: { measure: 'sales' }, hidden: true }, { key: 'b', point: { measure: 'qty' } }]));
    expect(unsorted.sql).toContain('ORDER BY "c__b" DESC NULLS LAST');
  });

  it('works a formula measure and a snapshot measure out over the point\'s own dates', () => {
    const gp = compiled(custom([{ key: 'gp_ly', point: { measure: 'gp', period: LAST_YEAR } }]));
    expect(gp.sql).toContain('/ NULLIF((SUM(f."amount") FILTER (WHERE f."__w1")), 0)) AS DOUBLE) AS "p1"');
    expect(gp.sql).toContain('(SUM(f."cost") FILTER (WHERE f."__w1"))');
    expect(gp.columns[1]).toMatchObject({ measure: 'gp', format: 'percent' });
    const soh = compiled(custom([{ key: 'stock', point: { measure: 'soh' } }, now]));
    expect(soh.sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__l1") AS DOUBLE) AS "p1"');
    expect(soh.sql).toContain('FROM (SELECT *, ("__w1" AND "sale_date" = MAX("sale_date") FILTER (WHERE "__w1") OVER ()) AS "__l1" FROM (SELECT *, (');
    expect(compiled(custom([now])).sql).not.toContain('"__l1"');
  });

  it('takes the drill path, properties, a rule through a parent dimension and the total row', () => {
    const out = compiled(custom(
      [{ key: 'kept', point: { measure: 'sales', where: { dimension: 'department', cmp: 'not_in', values: ['D1'] } } }],
      { group_by: 'product', properties: ['name'], path: [{ dimension: 'branch', selected: ['4'] }], options: { total_row: true } },
    ));
    expect(out.sql).toContain('FILTER (WHERE f."__w1" AND ("d_product"."dept" IS NULL OR CAST("d_product"."dept" AS VARCHAR) NOT IN (\'D1\')))');
    expect(out.sql).toContain('CASE WHEN GROUPING(f."product_code") = 0 THEN any_value("d_product"."name") END AS "prop__name"');
    expect(out.sql).toContain('WHERE CAST(f."branch_code" AS VARCHAR) IN (\'4\')');
    expect(out.sql).toContain('GROUP BY GROUPING SETS ((f."product_code"), ())');
    expect(out.sql).toContain('CAST(GROUPING(f."product_code") AS INTEGER) AS "__total"');
    expect(out.tables).toEqual(['sales_lines', 'products']);
  });

  it('adds sum and average rows and hides zero rows over the shown columns', () => {
    const out = compiled(custom([now, { key: 'h', point: { measure: 'qty' }, hidden: true }], { options: { sum_row: true, average_row: true, hide_zero_rows: true } }));
    expect(out.sql).toContain('SELECT avg("c__now") AS "c__now", 3 AS "__total"');
    expect(out.sql).toContain('SELECT sum("c__now") AS "c__now", 4 AS "__total"');
    expect(out.sql).toContain('WHERE "__total" = 1 OR (COALESCE("c__now", 0) <> 0)');
  });

  it.each([
    [custom([]), 'bad_custom_column'],
    [{ mode: 'custom' }, 'bad_custom_column'],
    [custom([now, now]), 'bad_custom_column'],
    [custom([{ key: 'two words', point: { measure: 'sales' } }]), 'bad_custom_column'],
    [custom([{ key: 'x' }]), 'bad_custom_column'],
    [custom([{ key: 'x', point: { measure: 'sales' }, expression: 'a', points: { a: { measure: 'sales' } } }]), 'bad_custom_column'],
    [custom([{ key: 'x', point: { measure: 'sales' }, show: 'percent' }]), 'bad_custom_column'],
    [custom([{ key: 'x', point: { measure: 'sales' }, against: { measure: 'qty' }, show: 'ratio' }]), 'bad_custom_column'],
    [custom([{ key: 'x', expression: 'a / b', points: { a: { measure: 'sales' } } }]), 'bad_custom_column'],
    [custom([{ key: 'x', expression: 'a', points: { a: { measure: 'sales' } }, format: 'money' }]), 'bad_custom_column'],
    [custom([{ key: 'x', expression: '1 + 1' }]), 'bad_custom_column'],
    [custom([{ key: 'x', point: { measure: 'sales' }, hidden: true }]), 'bad_custom_column'],
    [custom([{ key: 'x', point: { measure: 'sales', where: 'branch 4' } }]), 'bad_custom_column'],
    [custom([{ key: 'x', expression: 'a +', points: { a: { measure: 'sales' } } }]), 'formula_syntax'],
    [custom([{ key: 'x', point: { measure: 'nope' } }]), 'unknown_measure'],
    [custom([{ key: 'x', point: { measure: 'ordered' } }]), 'measure_not_on_stream'],
    [custom([{ key: 'x', point: { measure: 'sales', period: { named: 'nope' } } }]), 'unknown_period'],
    [custom([{ key: 'x', point: { measure: 'sales', where: { dimension: 'customer', cmp: 'in', values: ['C1'] } } }]), 'dimension_not_on_stream'],
    [custom([now], { filters: { op: 'and', rules: [{ measure: 'sales', cmp: '>', value: 0 }] } }), 'measure_filter_unsupported'],
    [custom([now], { options: { activity: 'all' } }), 'option_unsupported'],
    [custom([now], { options: { others_row: true } }), 'option_unsupported'],
    [custom([now], { sort: { by: 'total.sales', dir: 'desc' } }), 'bad_sort'],
    [custom([now], { sort: { by: 'column.nope', dir: 'desc' } }), 'bad_sort'],
  ])('refuses %j with %s', (change, reason) => {
    expect(refusal(change as Record<string, unknown>)).toBe(reason);
  });

  it('is answered from a rollup when every window is whole months', () => {
    const roll = (columns: unknown[]) => compileRollupView(fixtureModel(), { ...base, ...custom(columns) } as ViewState, { today: TODAY });
    const small = roll([now, { key: 'n', point: { measure: 'lines', period: LAST_YEAR } }]);
    expect(small.ok && small.rollups).toEqual([{ stream: 'sales', rollup: 'by_branch', table: 'sales_month_branch' }]);
    expect(small.ok && small.sql).toContain('CAST(COALESCE(SUM(f."line_count") FILTER (WHERE f."__w2"), 0) AS DOUBLE) AS "p2"');
    expect(small.ok && small.sql).toContain('FROM "sales_month_branch" WHERE ("month" >= DATE \'2026-11-01\'');
    const wide = roll([{ key: 'p', point: { measure: 'sales', where: { dimension: 'product', cmp: 'in', values: ['P1'] } } }]);
    expect(wide.ok && wide.rollups).toEqual([{ stream: 'sales', rollup: 'by_product_branch', table: 'sales_month_product_branch' }]);
    const week = roll([now, { key: 'w', point: { measure: 'sales', period: { custom: { from: '2026-11-02', to: '2026-11-08' } } } }]);
    expect(week.ok ? 'did not refuse' : week.reason).toBe('no_rollup');
  });
});

describe('compileView, period variance mode', () => {
  const view = { mode: 'period_variance', measures: ['sales'], period: { preset: 'rolling_3' } };
  const cur = '"sale_date" >= DATE \'2026-09-01\' AND "sale_date" < DATE \'2026-12-01\'';
  const prev = '"sale_date" >= DATE \'2025-09-01\' AND "sale_date" < DATE \'2025-12-01\'';

  it('sets each period beside the period at the same place in the comparison window', () => {
    const out = compiled(view);
    expect(out.columns.map((c) => c.name)).toEqual([
      'code',
      'b1__sales', 'pb1__sales', 'bv1__sales', 'bvp1__sales',
      'b2__sales', 'pb2__sales', 'bv2__sales', 'bvp2__sales',
      'b3__sales', 'pb3__sales', 'bv3__sales', 'bvp3__sales',
      'm__sales', 'prev__sales', 'var__sales', 'varp__sales', '__total', '__rows',
    ]);
    expect(out.sql).toContain(
      `FROM (SELECT *, CASE WHEN ${cur} THEN CASE WHEN "sale_date" < DATE '2026-10-01' THEN 1 WHEN "sale_date" < DATE '2026-11-01' THEN 2 WHEN "sale_date" < DATE '2026-12-01' THEN 3 END END AS "__b", `
        + `CASE WHEN ${prev} THEN CASE WHEN "sale_date" < DATE '2025-10-01' THEN 1 WHEN "sale_date" < DATE '2025-11-01' THEN 2 WHEN "sale_date" < DATE '2025-12-01' THEN 3 END END AS "__pb", `
        + `(${cur}) AS "__cur", (${prev}) AS "__prev" FROM "sales_lines" WHERE (${cur}) OR (${prev})) AS f`,
    );
    expect(out.sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__b" = 2) AS DOUBLE) AS "b2__sales", CAST(SUM(f."amount") FILTER (WHERE f."__pb" = 2) AS DOUBLE) AS "pb2__sales"');
    expect(out.sql).toContain('CAST(SUM(f."amount") FILTER (WHERE f."__cur") AS DOUBLE) AS "m__sales", CAST(SUM(f."amount") FILTER (WHERE f."__prev") AS DOUBLE) AS "prev__sales"');
    expect(out.sql).toContain('COALESCE("b3__sales", 0) - COALESCE("pb3__sales", 0) AS "bv3__sales", (COALESCE("b3__sales", 0) - "pb3__sales") / NULLIF(abs("pb3__sales"), 0) AS "bvp3__sales"');
    expect(out.sql).toContain('ORDER BY "m__sales" DESC NULLS LAST, "code" ASC');
    expect(out.columns[1]).toMatchObject({ label: 'Sales Sep 2026', part: 'current', bucket: 1, period: { from: '2026-09-01', to: '2026-10-01' } });
    expect(out.columns[2]).toMatchObject({ label: 'Sales Sep 2025', part: 'previous', bucket: 1, period: { from: '2025-09-01', to: '2025-10-01' } });
    expect(out.columns[4]).toMatchObject({ label: 'Sales Sep 2026 Variance %', format: 'percent', part: 'variance_pct', bucket: 1, period: { from: '2026-09-01' } });
    expect(out.columns[13]).toMatchObject({ name: 'm__sales', label: 'Sales Total', part: 'current' });
    expect(out.columns[13]?.bucket).toBeUndefined();
    expect(out.comparison).toEqual({ from: '2025-09-01', to: '2025-12-01' });
    expect(out.buckets.map((b) => b.label)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);
    expect(out.months).toEqual({ from: '2025-09', to: '2026-11' });
  });

  it('pairs periods by their place, and lists the newest first when reversed', () => {
    const out = compiled({ ...view, compare: 'previous_period', options: { reverse_periods: true } });
    expect(out.comparison).toEqual({ from: '2026-06-01', to: '2026-09-01' });
    expect(out.columns.slice(1, 3).map((c) => [c.name, c.label])).toEqual([['b3__sales', 'Sales Nov 2026'], ['pb3__sales', 'Sales Aug 2026']]);
  });

  it('sorts by one period and filters on the variance of the whole period', () => {
    const { sql } = compiled({
      ...view,
      sort: { by: 'period.2.sales', dir: 'asc' },
      filters: { op: 'and', rules: [{ measure: 'sales', of: 'variance', cmp: '<', value: 0 }] },
    });
    expect(sql).toContain('ORDER BY "b2__sales" ASC NULLS LAST, "code" ASC');
    expect(sql).toContain('FROM v\nWHERE "__total" = 1 OR ("var__sales" < 0)\n)');
  });

  it('reads a snapshot measure on the latest day of each period of both windows', () => {
    const { sql } = compiled({ ...view, measures: ['soh'] });
    expect(sql).toContain('CAST(SUM(f."qty") FILTER (WHERE f."__b" = 1 AND f."__last") AS DOUBLE) AS "b1__soh", CAST(SUM(f."qty") FILTER (WHERE f."__pb" = 1 AND f."__plast") AS DOUBLE) AS "pb1__soh"');
    expect(sql).toContain(
      'FROM (SELECT *, ("sale_date" = MAX("sale_date") OVER (PARTITION BY "__b")) AS "__last", ("sale_date" = MAX("sale_date") OVER (PARTITION BY "__pb")) AS "__plast", '
        + '("__cur" AND "sale_date" = MAX("sale_date") FILTER (WHERE "__cur") OVER ()) AS "__lastc", ("__prev" AND "sale_date" = MAX("sale_date") FILTER (WHERE "__prev") OVER ()) AS "__lastp" FROM (SELECT *, CASE WHEN',
    );
  });

  it('refuses a comparison window that cuts into a different number of periods', () => {
    expect(refusal({ ...view, compare: { period: { custom: { from: '2025-01-01', to: '2025-02-28' } } } })).toBe('option_unsupported');
    expect(refusal({ ...view, compare: 'last_decade' })).toBe('option_unsupported');
  });

  it('is answered from a rollup when the periods are whole months', () => {
    const out = compileRollupView(fixtureModel(), { ...base, ...view } as ViewState, { today: TODAY });
    expect(out.ok && out.rollups).toEqual([{ stream: 'sales', rollup: 'by_branch', table: 'sales_month_branch' }]);
    expect(out.ok && out.sql).toContain('FROM "sales_month_branch" WHERE');
  });
});

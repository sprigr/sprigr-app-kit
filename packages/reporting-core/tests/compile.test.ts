import { describe, it, expect } from 'vitest';
import { compileView, type CompiledView, type ViewState } from '../src';
import { fixtureModel } from './fixture';

const TODAY = '2026-11-21';
const base: ViewState = { mode: 'total', stream: 'sales', measures: ['sales'], period: { preset: 'current_month' }, group_by: 'branch' };

function compiled(change: Record<string, unknown> = {}, ctx: { maxSqlChars?: number } = {}): CompiledView {
  const out = compileView(fixtureModel(), { ...base, ...change } as ViewState, { today: TODAY, ...ctx });
  if (!out.ok) throw new Error(`refused: ${out.reason}: ${out.detail}`);
  return out;
}

function refusal(change: Record<string, unknown>, ctx: { maxSqlChars?: number } = {}): string {
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
    [{ mode: 'matrix', across: { dimension: 'product' }, limit: 200 }, 'bad_paging'],
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
    [{ options: { others_row: true } }, 'option_unsupported'],
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
      'WITH g AS MATERIALIZED (',
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
      'WHERE rw."__row" > 0 AND rw."__row" <= 153 AND (g."__across_total" = 1 OR cl."__col" <= 12)',
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
    expect(wide.ok ? wide.sql : wide.reason).toContain('rw."__row" <= 200 AND');
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

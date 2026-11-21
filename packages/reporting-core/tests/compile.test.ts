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
    [{ mode: 'variance' }, 'mode_unsupported'],
    [{ stream: 'nope' }, 'unknown_stream'],
    [{ measures: [] }, 'no_measures'],
    [{ measures: ['sales', 'sales'] }, 'duplicate_measure'],
    [{ measures: ['nope'] }, 'unknown_measure'],
    [{ measures: ['soh'] }, 'snapshot_measure_unsupported'],
    [{ measures: ['ordered'] }, 'measure_not_on_stream'],
    [{ group_by: 'customer' }, 'dimension_not_on_stream'],
    [{ group_by: 'nope' }, 'unknown_dimension'],
    [{ properties: ['colour'] }, 'unknown_property'],
    [{ properties: ['name'] }, 'unknown_property'],
    [{ path: [{ dimension: 'branch', selected: [] }] }, 'empty_selection'],
    [{ filters: { op: 'and', rules: [{ measure: 'sales', cmp: '<', value: 1 }] } }, 'measure_filter_unsupported'],
    [{ filters: { op: 'and', rules: [{ op: 'or', rules: [] }] } }, 'empty_filter'],
    [{ sort: { by: 'total.cost', dir: 'desc' } }, 'bad_sort'],
    [{ sort: { by: 'total.sales', dir: 'sideways' } }, 'bad_sort'],
    [{ limit: 5000 }, 'bad_paging'],
    [{ limit: 2000, options: { total_row: true } }, 'bad_paging'],
    [{ offset: -1 }, 'bad_paging'],
    [{ period: { named: 'nope' } }, 'unknown_period'],
    [{ options: { activity: 'without' } }, 'option_unsupported'],
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

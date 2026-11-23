import { describe, it, expect } from 'vitest';
import { isFormulaMeasure, measureAvailability, validateModel } from '../src';
import { MODEL_JSON, fixtureModel } from './fixture';

/** The fixture with one part replaced. */
function withChange(change: Record<string, unknown>): unknown {
  return { ...structuredClone(MODEL_JSON), ...change };
}

/** The fixture with the first stream's rollups replaced. */
function withRollups(rollups: unknown[]): unknown {
  const model = structuredClone(MODEL_JSON);
  return { ...model, streams: [{ ...model.streams[0], rollups }, ...model.streams.slice(1)] };
}

function problemsOf(input: unknown): string[] {
  const checked = validateModel(input);
  return checked.ok ? [] : checked.problems.map((p) => p.reason);
}

describe('validateModel', () => {
  it('accepts the fixture and fills the defaults', () => {
    const model = fixtureModel();
    const lines = model.measures.find((m) => m.key === 'lines');
    expect(lines && !isFormulaMeasure(lines) ? lines : null).toMatchObject({ agg: 'count', stream: 'sales', format: 'number', snapshot: false });
    expect(model.dimensions.find((d) => d.key === 'department')?.via).toEqual({ dimension: 'product', column: 'dept' });
    expect(model.periods.fiscal_year_start_month).toBe(7);
    expect(model.streams.map((s) => s.columns)).toEqual([[{ key: 'doc', label: 'Document', column: 'doc_no' }], []]);
    expect(model.streams.map((s) => s.rollups.map((r) => r.key))).toEqual([['by_product_branch', 'by_branch'], ['by_product']]);
  });

  it.each([
    ['a rollup keeping a dimension its stream lacks', withRollups([{ key: 'r', table: 't', date: 'month', dimension_keys: { customer: 'c' } }]), 'rollup_dimension_not_on_stream'],
    ['a rollup carrying a formula', withRollups([{ key: 'r', table: 't', date: 'month', measure_columns: { gp: 'gp' } }]), 'rollup_measure_unknown'],
    ['a rollup carrying a measure of another stream', withRollups([{ key: 'r', table: 't', date: 'month', measure_columns: { ordered: 'amount' } }]), 'rollup_measure_unknown'],
    ['a rollup carrying a snapshot', withRollups([{ key: 'r', table: 't', date: 'month', measure_columns: { soh: 'qty' } }]), 'rollup_measure_not_additive'],
    ['a rollup key used twice', withRollups([{ key: 'r', table: 't', date: 'month' }, { key: 'r', table: 'u', date: 'month' }]), 'duplicate_key'],
    ['a rollup with no month column', withRollups([{ key: 'r', table: 't' }]), 'missing_field'],
    ['a stream table named like a stage of the statement', withChange({ streams: [{ key: 'sales', table: 's2', date: 'd' }] }), 'reserved_table_name'],
    ['a dimension table named like a stage, in any case', withChange({ dimensions: [{ key: 'product', table: 'RW', code: 'code' }] }), 'reserved_table_name'],
    ['a rollup table named like a stage', withRollups([{ key: 'r', table: 'sm', date: 'month' }]), 'reserved_table_name'],
    ['a column named for a word the route refuses, in any case', withChange({ streams: [{ key: 'sales', table: 'sales_lines', date: 'Update' }] }), 'reserved_name'],
    ['a table named for a word the route refuses', withChange({ dimensions: [{ key: 'product', table: 'load', code: 'code' }] }), 'reserved_name'],
    ['a model that is not an object', 'nope', 'not_an_object'],
    ['another model version', withChange({ model_version: 2 }), 'unsupported_model_version'],
    ['no streams', { model_version: 1, streams: [], dimensions: [], measures: [] }, 'no_streams'],
    ['a table name that is not plain', withChange({ streams: [{ key: 'sales', table: 'sales_lines; DROP', date: 'sale_date' }] }), 'bad_identifier'],
    ['a key in upper case', withChange({ dimensions: [{ key: 'Product' }] }), 'bad_key'],
    ['a stream keyed on an unknown dimension', withChange({ streams: [{ key: 'sales', table: 't', date: 'd', dimension_keys: { colour: 'c' } }] }), 'unknown_dimension'],
    ['a stream column that is not a plain name', withChange({ streams: [{ key: 'sales', table: 't', date: 'd', columns: [{ key: 'doc', column: 'doc no' }] }] }), 'bad_identifier'],
    ['a stream column key used twice', withChange({ streams: [{ key: 'sales', table: 't', date: 'd', columns: [{ key: 'doc', column: 'a' }, { key: 'doc', column: 'b' }] }] }), 'duplicate_key'],
    ['a measure key used twice', withChange({ measures: [{ key: 'a', agg: 'count' }, { key: 'a', agg: 'count' }] }), 'duplicate_key'],
    ['a measure that is both an agg and a formula', withChange({ measures: [{ key: 'a', agg: 'sum', column: 'x', formula: '1' }] }), 'measure_shape'],
    ['an unknown agg', withChange({ measures: [{ key: 'a', agg: 'median', column: 'x' }] }), 'unknown_agg'],
    ['a sum with no column', withChange({ measures: [{ key: 'a', agg: 'sum' }] }), 'missing_field'],
    ['a count that multiplies two columns', withChange({ measures: [{ key: 'a', agg: 'count', column: 'x', times: 'y' }] }), 'measure_shape'],
    ['a distinct count that multiplies two columns', withChange({ measures: [{ key: 'a', agg: 'count_distinct', column: 'x', times: 'y' }] }), 'measure_shape'],
    ['a second column that is not a plain name', withChange({ measures: [{ key: 'a', agg: 'sum', column: 'x', times: 'y z' }] }), 'bad_identifier'],
    ['a second column named for a word the route refuses', withChange({ measures: [{ key: 'a', agg: 'sum', column: 'x', times: 'update' }] }), 'reserved_name'],
    ['a second column on a formula', withChange({ measures: [{ key: 'a', agg: 'count' }, { key: 'b', formula: 'a + 1', times: 'y' }] }), 'measure_shape'],
    ['a measure on an unknown stream', withChange({ measures: [{ key: 'a', agg: 'count', stream: 'nope' }] }), 'unknown_stream'],
    ['a formula that does not parse', withChange({ measures: [{ key: 'a', agg: 'count' }, { key: 'b', formula: 'a -' }] }), 'formula_invalid'],
    ['a formula naming no measure', withChange({ measures: [{ key: 'a', agg: 'count' }, { key: 'b', formula: 'a - nope' }] }), 'formula_unknown_measure'],
    ['formulas that refer to each other', withChange({ measures: [{ key: 'a', formula: 'b + 1' }, { key: 'b', formula: 'a + 1' }] }), 'formula_cycle'],
    ['a via to an unknown dimension', withChange({ dimensions: [{ key: 'product' }, { key: 'branch' }, { key: 'region', via: { dimension: 'nope', column: 'r' } }] }), 'unknown_dimension'],
    ['a via whose parent has no table', withChange({ dimensions: [{ key: 'product' }, { key: 'branch' }, { key: 'region', via: { dimension: 'branch', column: 'r' } }] }), 'via_parent_has_no_table'],
    ['a via chain that loops', withChange({ dimensions: [
      { key: 'product', table: 'p', code: 'c', via: { dimension: 'branch', column: 'x' } },
      { key: 'branch', table: 'b', code: 'c', via: { dimension: 'product', column: 'y' } },
    ] }), 'dimension_cycle'],
    ['a property with no table to read it from', withChange({ dimensions: [{ key: 'product' }, { key: 'branch', properties: [{ key: 'state', column: 's' }] }] }), 'dimension_table_incomplete'],
    ['a financial year starting in month 13', withChange({ periods: { fiscal_year_start_month: 13 } }), 'bad_fiscal_month'],
    ['a named period that ends before it starts', withChange({ periods: { custom: [{ key: 'x', from: '2026-02-01', to: '2026-01-01' }] } }), 'period_range_inverted'],
    ['a named period on a date that does not exist', withChange({ periods: { custom: [{ key: 'x', from: '2026-02-30', to: '2026-03-01' }] } }), 'bad_date'],
  ])('refuses %s', (_what, input, reason) => {
    expect(problemsOf(input)).toContain(reason);
  });

  it('says where each problem is', () => {
    const pathsOf = (input: unknown): string[] => {
      const checked = validateModel(input);
      return checked.ok ? [] : checked.problems.map((p) => p.path);
    };
    // The fixture's measures stay, since its rollups carry them.
    const measures = [...MODEL_JSON.measures, { key: 'a', agg: 'median', column: 'x' }];
    expect(pathsOf(withChange({ measures }))).toEqual([`measures[${MODEL_JSON.measures.length}].agg`]);
    expect(pathsOf(withRollups([{ key: 'r', table: 't', date: 'month', measure_columns: { soh: 'qty' } }]))).toEqual(['streams.sales.rollups.r.measure_columns.soh']);
  });
});

describe('measureAvailability', () => {
  it('hides a measure whose column the role does not hold, and every formula built on it', () => {
    const seen = measureAvailability(fixtureModel(), { sales_lines: ['sale_date', 'product_code', 'amount', 'qty'] });
    expect(seen).toMatchObject({ sales: true, qty: true, lines: true, cost: false, profit: false, gp: false, ordered: false });
  });

  it('hides a measure of two columns when the role holds only one of them', () => {
    const checked = validateModel(withChange({ measures: [...MODEL_JSON.measures, { key: 'value', agg: 'sum', column: 'qty', times: 'unit_cost' }] }));
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    const value = checked.model.measures.find((m) => m.key === 'value');
    expect(value && !isFormulaMeasure(value) ? value.times : null).toBe('unit_cost');
    expect(measureAvailability(checked.model, { sales_lines: ['sale_date', 'qty'] })).toMatchObject({ qty: true, value: false });
    expect(measureAvailability(checked.model, { sales_lines: ['sale_date', 'qty', 'Unit_Cost'] })).toMatchObject({ value: true });
  });
});

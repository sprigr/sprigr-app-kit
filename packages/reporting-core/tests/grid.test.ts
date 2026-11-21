import { describe, it, expect } from 'vitest';
import { compileView, pivotLong, type CompiledView, type ResultRow, type ViewState } from '../src';
import { fixtureModel, reasonOf } from './fixture';

const base: ViewState = { mode: 'matrix', stream: 'sales', measures: ['sales'], period: { preset: 'current_month' }, group_by: 'branch', across: { dimension: 'product' } };

function compiled(change: Record<string, unknown> = {}, ctx: { periodShape?: 'wide' | 'long' } = {}): CompiledView {
  const out = compileView(fixtureModel(), { ...base, ...change } as ViewState, { today: '2026-11-21', ...ctx });
  if (!out.ok) throw new Error(`refused: ${out.reason}: ${out.detail}`);
  return out;
}

/** One result row of a long result. `row` and `col` are 0 on a total. */
function line(code: unknown, across: unknown, sales: number, row: number | bigint, col: number | bigint, more: ResultRow = {}): ResultRow {
  return { code, across, m__sales: sales, __total: Number(row) === 0 ? 1 : 0, __across_total: Number(col) === 0 ? 1 : 0, __row: row, __col: col, __rows: 2, __cols: 2, ...more };
}

describe('pivotLong, a matrix', () => {
  it('folds cells, row totals and the total row into one grid row per member', () => {
    const grid = pivotLong(compiled({ options: { total_row: true } }), [
      line(null, null, 230, 0, 0),
      line(null, 'P1', 200, 0, 1, { across__name: 'Koala' }),
      line(null, 'P2', 30, 0, 2, { across__name: 'Wombat' }),
      line(1, null, 180, 1, 0),
      line(1, 'P1', 150, 1, 1, { across__name: 'Koala' }),
      line(1, 'P2', 30, 1, 2, { across__name: 'Wombat' }),
      line(2, null, 50, 2, 0),
      line(2, 'P1', 50, 2, 1, { across__name: 'Koala' }),
    ]);
    expect(grid.columns).toEqual([{ number: 1, across: 'P1', label: 'Koala' }, { number: 2, across: 'P2', label: 'Wombat' }]);
    expect(grid.rows).toEqual([
      { code: null, total: true, number: 0, properties: {}, cells: [{ m__sales: 200 }, { m__sales: 30 }], totals: { m__sales: 230 } },
      { code: 1, total: false, number: 1, properties: {}, cells: [{ m__sales: 150 }, { m__sales: 30 }], totals: { m__sales: 180 } },
      { code: 2, total: false, number: 2, properties: {}, cells: [{ m__sales: 50 }, null], totals: { m__sales: 50 } },
    ]);
    expect(grid.measures.map((m) => m.name)).toEqual(['m__sales']);
    expect([grid.rowCount, grid.columnCount]).toEqual([2, 2]);
  });

  it('takes whole numbers as bigints, rows in any order, and a column label from the code when there is no name', () => {
    const view = compiled({ group_by: 'product', across: { dimension: 'branch' }, properties: ['name'] });
    const grid = pivotLong(view, [
      line('P2', 7, 30, 2n, 2n),
      line('P1', 4, 150, 1n, 1n),
      line('P2', null, 30, 2n, 0n, { prop__name: 'Wombat' }),
      line('P1', null, 150, 1n, 0n, { prop__name: 'Koala' }),
    ]);
    expect(grid.columns).toEqual([{ number: 1, across: 4, label: '4' }, { number: 2, across: 7, label: '7' }]);
    expect(grid.rows).toEqual([
      { code: 'P1', total: false, number: 1, properties: { prop__name: 'Koala' }, cells: [{ m__sales: 150 }, null], totals: { m__sales: 150 } },
      { code: 'P2', total: false, number: 2, properties: { prop__name: 'Wombat' }, cells: [null, { m__sales: 30 }], totals: { m__sales: 30 } },
    ]);
  });

  it('gives an empty grid for no rows', () => {
    expect(pivotLong(compiled(), [])).toMatchObject({ columns: [], rows: [], rowCount: 0, columnCount: 0 });
  });
});

describe('pivotLong, a period view returned long', () => {
  const periods = { mode: 'period', period: { preset: 'rolling_3' }, across: undefined };
  const rows = [line(1, null, 90, 1, 0), line(1, 1, 40, 1, 1), line(1, 3, 50, 1, 3)];

  it('lists every period as a column, and leaves a period with no rows blank', () => {
    const grid = pivotLong(compiled(periods, { periodShape: 'long' }), rows);
    expect(grid.columns.map((c) => [c.number, c.across, c.label])).toEqual([[1, 1, 'Sep 2026'], [2, 2, 'Oct 2026'], [3, 3, 'Nov 2026']]);
    expect(grid.columns[0]?.period).toMatchObject({ from: '2026-09-01', to: '2026-10-01' });
    expect(grid.rows).toEqual([
      { code: 1, total: false, number: 1, properties: {}, cells: [{ m__sales: 40 }, null, { m__sales: 50 }], totals: { m__sales: 90 } },
    ]);
  });

  it('puts the newest period first when the view reverses them', () => {
    const view = compiled({ ...periods, options: { reverse_periods: true } }, { periodShape: 'long' });
    expect(view.reversed).toBe(true);
    const grid = pivotLong(view, [line(1, null, 90, 1, 0), line(1, 1, 40, 1, 3), line(1, 3, 50, 1, 1)]);
    expect(grid.columns.map((c) => c.label)).toEqual(['Nov 2026', 'Oct 2026', 'Sep 2026']);
    expect(grid.rows[0]?.cells).toEqual([{ m__sales: 50 }, null, { m__sales: 40 }]);
  });

  it('refuses a result that already has one row per member', () => {
    expect(reasonOf(() => pivotLong(compiled(periods), rows))).toBe('result_not_long');
    expect(compiled(periods).reversed).toBeUndefined();
  });
});

/**
 * The grid of a long result.
 *
 * A matrix view, and a period view too long for one column per period, come back with one result
 * row per cell. `pivotLong` folds those rows to one grid row per member with one cell per column,
 * so a grid, an export and an email all lay the same result out the same way.
 */
import type { CompiledColumn, CompiledView } from './compile';
import type { PeriodBucket } from './periods';
import { ReportingError } from './reasons';

/** One row of a result, by column name, as the query route or DuckDB in the browser returns it. */
export type ResultRow = Record<string, unknown>;

/** The measures of one cell or one total, by result column name such as `m__sales`. */
export type GridFigures = Record<string, number | null>;

export interface GridColumn {
  /** Where the column stands, from 1. */
  number: number;
  /** A matrix: the member's code. A period view: the period's number from the oldest. */
  across: unknown;
  label: string;
  /** A period view: the period the column covers. */
  period?: PeriodBucket;
}

export interface GridRow {
  /** The member's code, or null on the total row. */
  code: unknown;
  total: boolean;
  /** The member's place in the sorted list, from 1; 0 on the total row. */
  number: number;
  /** Property columns by result column name, such as `prop__name`. Empty on the total row. */
  properties: Record<string, unknown>;
  /** One per grid column, in column order. Null where no fact row falls. */
  cells: Array<GridFigures | null>;
  /** The row's own total over every column, whether or not the column is kept. */
  totals: GridFigures;
}

export interface Grid {
  columns: GridColumn[];
  /** The total row first when the result holds one, then the members of this page in order. */
  rows: GridRow[];
  /** The measure columns each cell holds, in the view's order. */
  measures: CompiledColumn[];
  /** Members in the whole list, before paging. */
  rowCount: number;
  /** Columns in the whole result, before the cut to the columns kept. */
  columnCount: number;
}

/** DuckDB in the browser hands a whole number back as a bigint; the route hands back a number. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

/**
 * Fold the rows of a long result into a grid.
 *
 * A period view lists every period as a column, whether or not a row falls in it. A matrix lists
 * the columns its rows hold: with `options.total_row` that is every column kept, and without it a
 * column no member of this page has a cell in is left out.
 */
export function pivotLong(compiled: CompiledView, rows: ResultRow[]): Grid {
  if (compiled.shape !== 'long') throw new ReportingError('result_not_long', 'only a long result is pivoted; this one already has one row per member');
  const measures = compiled.columns.filter((c) => c.kind === 'measure');
  const properties = compiled.columns.filter((c) => c.kind === 'property');
  const flag = (row: ResultRow, name: string): boolean => toNumber(row[name]) === 1;
  const figures = (row: ResultRow): GridFigures => Object.fromEntries(measures.map((m) => [m.name, toNumber(row[m.name])]));

  const columns: GridColumn[] = [];
  if (compiled.across === undefined) {
    const count = compiled.buckets.length;
    compiled.buckets.forEach((bucket, i) => {
      columns.push({ number: compiled.reversed ? count - i : i + 1, across: i + 1, label: bucket.label, period: bucket });
    });
  } else {
    const seen = new Set<number>();
    for (const row of rows) {
      const number = toNumber(row.__col) ?? 0;
      if (flag(row, '__across_total') || number < 1 || seen.has(number)) continue;
      seen.add(number);
      const name = row.across__name;
      columns.push({ number, across: row.across, label: typeof name === 'string' && name !== '' ? name : String(row.across ?? '') });
    }
  }
  columns.sort((a, b) => a.number - b.number);
  const placeOf = new Map(columns.map((column, i) => [column.number, i]));

  const members = new Map<number, GridRow>();
  let total: GridRow | null = null;
  for (const row of rows) {
    const isTotal = flag(row, '__total');
    const number = isTotal ? 0 : toNumber(row.__row) ?? 0;
    const existing = isTotal ? total : members.get(number);
    const target: GridRow = existing ?? { code: isTotal ? null : row.code, total: isTotal, number, properties: {}, cells: columns.map(() => null), totals: {} };
    if (!existing) {
      if (isTotal) total = target;
      else members.set(number, target);
    }
    if (flag(row, '__across_total')) {
      target.totals = figures(row);
      if (!isTotal) for (const property of properties) target.properties[property.name] = row[property.name] ?? null;
    } else {
      const place = placeOf.get(toNumber(row.__col) ?? 0);
      if (place !== undefined) target.cells[place] = figures(row);
    }
  }

  const listed = [...members.values()].sort((a, b) => a.number - b.number);
  const first = rows[0];
  return {
    columns,
    rows: total ? [total, ...listed] : listed,
    measures,
    rowCount: toNumber(first?.__rows) ?? 0,
    columnCount: toNumber(first?.__cols) ?? columns.length,
  };
}

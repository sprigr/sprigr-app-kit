/**
 * The compiler: a view state in, one DuckDB statement out, plus the column map
 * a grid renders from. The same statement runs through the platform's query
 * route or in DuckDB in the browser.
 *
 * It never decides who may see a column or a row. It runs against whatever
 * tables the caller's role holds.
 *
 * Shape of the statement (period mode, total row on):
 *
 *   WITH g AS (
 *     SELECT <code> AS "code", <properties>, <one column per measure and period>, <totals>
 *     FROM (SELECT *, CASE ... END AS "__b" FROM <fact> WHERE <date window>) AS f
 *     LEFT JOIN <dimension tables>
 *     WHERE <drill path, filters, keyword>
 *     GROUP BY GROUPING SETS ((<code>), ())
 *   ), r AS (<row number per sort, row count>)
 *   SELECT ... one page of rows, with the total row first
 *
 * Each period column is an aggregate with `FILTER (WHERE "__b" = n)`, so the
 * date is compared once per row, not once per column.
 */
import { emitFormulaSql, parseFormula, type FormulaNode } from './formula';
import { isFormulaMeasure, type ModelDimension, type ModelMeasure, type ModelStream, type ReportingModel } from './model';
import { monthsRange, resolvePeriod, type PeriodBucket, type PeriodSpec, type PeriodWindow } from './periods';
import { ReportingError, refusalOf, type Refusal, type ReportingReason } from './reasons';
import { likeContains, quoteIdent as q, sqlDate, sqlString } from './sql';

/** The query route refuses longer SQL (`ANALYTICS_QUERY_MAX_SQL_CHARS` in sprigr-team). */
export const ROUTE_MAX_SQL_CHARS = 24_000;
/** The query route's row cap (`ANALYTICS_QUERY_MAX_ROWS` in sprigr-team). */
export const ROUTE_MAX_ROWS = 2_000;
export const DEFAULT_PAGE_ROWS = 200;
const MAX_KEYWORD_CHARS = 200;
const MAX_FILTER_DEPTH = 3;

export interface ViewPathStep { dimension: string; selected: string[] }
export interface ViewDimensionRule { dimension: string; property?: string; cmp: 'in' | 'not_in'; values: string[] }
export interface ViewMeasureRule { measure: string; cmp: string; value: number }
export interface ViewFilterGroup { op: 'and' | 'or'; rules: Array<ViewDimensionRule | ViewMeasureRule | ViewFilterGroup> }
export interface ViewSort { by: string; dir: 'asc' | 'desc' }
export interface ViewOptions {
  activity?: 'with' | 'without' | 'all';
  total_row?: boolean;
  others_row?: boolean;
  average_row?: boolean;
  period_to_date?: boolean;
  /** Newest period first. Changes column order only. */
  reverse_periods?: boolean;
}

/** What a saved view stores. */
export interface ViewState {
  mode: string;
  stream: string;
  measures: string[];
  period: PeriodSpec;
  /** Drill path: each step keeps only the selected codes of one dimension. */
  path?: ViewPathStep[];
  group_by: string;
  /** Properties of the group-by dimension to show: `name` or a property key. The code is always returned. */
  properties?: string[];
  filters?: ViewFilterGroup;
  keyword?: string;
  /** `code`, `property.<key>`, `total.<measure>` or `period.<n>.<measure>` (n counts from the oldest period). */
  sort?: ViewSort;
  limit?: number;
  offset?: number;
  options?: ViewOptions;
}

export interface CompileContext {
  /** Today in the tenant's time zone, `YYYY-MM-DD`. */
  today: string;
  /** Refuse SQL longer than this. The route's limit by default; pass `Infinity` for the browser engine. */
  maxSqlChars?: number;
  /** The most rows a result may hold, total row included. */
  maxRows?: number;
}

export interface CompiledColumn {
  /** The column's name in the result. */
  name: string;
  kind: 'code' | 'property' | 'measure' | 'meta';
  label: string;
  /** For a property column: its key. */
  property?: string;
  /** For a measure column: the measure key and its format. */
  measure?: string;
  format?: string;
  /** For a measure column: the period it covers, or null for the whole window. */
  period?: PeriodBucket | null;
}

export interface CompiledView {
  ok: true;
  sql: string;
  columns: CompiledColumn[];
  window: PeriodWindow;
  buckets: PeriodBucket[];
  /** Inclusive `YYYY-MM` range, for the query route's `months` argument. */
  months: { from: string; to: string };
}

const FACT = 'f';

function fail(reason: ReportingReason, detail: string): never {
  throw new ReportingError(reason, detail);
}

function isGroup(rule: unknown): rule is ViewFilterGroup {
  return typeof rule === 'object' && rule !== null && 'rules' in rule;
}

function stringList(values: unknown, what: string): string[] {
  if (!Array.isArray(values) || values.length === 0) fail('empty_selection', `${what} has nothing selected`);
  return (values as unknown[]).map((v) => {
    if (typeof v !== 'string' && typeof v !== 'number') fail('empty_selection', `${what} holds a value that is not text`);
    return String(v);
  });
}

export function compileView(model: ReportingModel, view: ViewState, ctx: CompileContext): CompiledView | Refusal {
  try {
    return compile(model, view, ctx);
  } catch (err) {
    return refusalOf(err);
  }
}

function compile(model: ReportingModel, view: ViewState, ctx: CompileContext): CompiledView {
  if (view.mode !== 'total' && view.mode !== 'period') fail('mode_unsupported', `mode "${String(view.mode)}" is not compiled yet`);
  const options: ViewOptions = view.options ?? {};
  if (options.activity !== undefined && options.activity !== 'with') fail('option_unsupported', 'only activity "with" is compiled yet');
  if (options.others_row || options.average_row) fail('option_unsupported', 'others and average rows are not compiled yet');
  const totalRow = options.total_row === true;

  const stream: ModelStream = model.streams.find((s) => s.key === view.stream) ?? fail('unknown_stream', `no stream "${String(view.stream)}"`);
  const dimByKey = new Map(model.dimensions.map((d) => [d.key, d]));
  const measureByKey = new Map(model.measures.map((m) => [m.key, m]));

  // Measures.
  if (!Array.isArray(view.measures) || view.measures.length === 0) fail('no_measures', 'a view needs at least one measure');
  const shown: ModelMeasure[] = view.measures.map((key, i) => {
    if (view.measures.indexOf(key) !== i) fail('duplicate_measure', `"${String(key)}" is listed twice`);
    return measureByKey.get(key) ?? fail('unknown_measure', `no measure "${String(key)}"`);
  });

  // Periods.
  const period = resolvePeriod(view.period, model.periods, ctx.today, { periodToDate: options.period_to_date === true });
  const buckets = view.mode === 'period' ? period.buckets : [];
  const windowDays = period.buckets.reduce((sum, b) => sum + b.days, 0);

  // Dimensions: each resolves to an expression for its code, adding the joins it needs.
  const joins = new Map<string, string>();
  const alias = (dim: ModelDimension): string => q(`d_${dim.key}`);
  const dimension = (key: string): ModelDimension => dimByKey.get(key) ?? fail('unknown_dimension', `no dimension "${String(key)}"`);
  const join = (dim: ModelDimension, codeExpr: string): string => {
    if (!dim.table || !dim.code) fail('dimension_has_no_table', `"${dim.key}" has no table to read from`);
    const a = alias(dim);
    if (!joins.has(a)) joins.set(a, `LEFT JOIN ${q(dim.table)} AS ${a} ON ${a}.${q(dim.code)} = ${codeExpr}`);
    return a;
  };
  const codeOf = (key: string, depth = 0): string => {
    if (depth > 20) fail('unknown_dimension', `the via chain of "${key}" does not end`);
    const dim = dimension(key);
    const direct = stream.dimension_keys[key];
    if (direct !== undefined) return `${FACT}.${q(direct)}`;
    if (!dim.via) fail('dimension_not_on_stream', `stream "${stream.key}" has no "${key}"`);
    const parent = dimension(dim.via.dimension);
    return `${join(parent, codeOf(parent.key, depth + 1))}.${q(dim.via.column)}`;
  };
  const propertyOf = (dimKey: string, property: string): string => {
    const code = codeOf(dimKey);
    if (property === 'code') return code;
    const dim = dimension(dimKey);
    const column = property === 'name' ? dim.name : dim.properties.find((p) => p.key === property)?.column;
    if (column === undefined) fail('unknown_property', `"${dimKey}" has no property "${String(property)}"`);
    return `${join(dim, code)}.${q(column)}`;
  };

  const groupDim = dimension(view.group_by);
  const codeExpr = codeOf(groupDim.key);

  // WHERE: the drill path, the filters and the keyword. The date window sits in the fact subquery.
  const where: string[] = [];
  const inList = (values: string[]): string => `(${values.map(sqlString).join(', ')})`;
  (view.path ?? []).forEach((step) => {
    const values = stringList(step?.selected, `the drill step on "${String(step?.dimension)}"`);
    where.push(`CAST(${codeOf(step.dimension)} AS VARCHAR) IN ${inList(values)}`);
  });
  const filterSql = (group: ViewFilterGroup, depth: number): string | null => {
    if (depth > MAX_FILTER_DEPTH) fail('filter_too_deep', `filters nest deeper than ${MAX_FILTER_DEPTH} levels`);
    if (group.op !== 'and' && group.op !== 'or') fail('empty_filter', 'a filter group needs op "and" or "or"');
    const rules = Array.isArray(group.rules) ? group.rules : [];
    if (rules.length === 0) return depth === 0 ? null : fail('empty_filter', 'a filter group has no rules');
    const parts = rules.map((rule) => {
      if (isGroup(rule)) return filterSql(rule, depth + 1) ?? fail('empty_filter', 'a filter group has no rules');
      if ('measure' in rule) fail('measure_filter_unsupported', 'filters on a measure are not compiled yet');
      if (rule.cmp !== 'in' && rule.cmp !== 'not_in') fail('empty_filter', `"${String(rule.cmp)}" is not a filter comparison`);
      const expr = propertyOf(rule.dimension, rule.property ?? 'code');
      const values = inList(stringList(rule.values, `the filter on "${String(rule.dimension)}"`));
      return rule.cmp === 'in'
        ? `CAST(${expr} AS VARCHAR) IN ${values}`
        : `(${expr} IS NULL OR CAST(${expr} AS VARCHAR) NOT IN ${values})`;
    });
    return `(${parts.join(group.op === 'and' ? ' AND ' : ' OR ')})`;
  };
  if (view.filters) {
    const clause = filterSql(view.filters, 0);
    if (clause !== null) where.push(clause);
  }
  const keyword = typeof view.keyword === 'string' ? view.keyword.trim() : '';
  if (keyword.length > MAX_KEYWORD_CHARS) fail('keyword_too_long', `the keyword is longer than ${MAX_KEYWORD_CHARS} characters`);
  if (keyword !== '') {
    const pattern = `${likeContains(keyword)} ESCAPE '\\'`;
    const targets = [`CAST(${codeExpr} AS VARCHAR) ILIKE ${pattern}`];
    if (groupDim.table && groupDim.name) targets.push(`${propertyOf(groupDim.key, 'name')} ILIKE ${pattern}`);
    where.push(`(${targets.join(' OR ')})`);
  }

  // Measures: an aggregate for a base measure, the formula over those aggregates otherwise.
  const parsed = new Map<string, FormulaNode>();
  const measureSql = (key: string, bucket: PeriodBucket | null, bucketIndex: number, depth: number): string => {
    if (depth > 20) fail('formula_cycle', `"${key}" refers back to itself`);
    const measure = measureByKey.get(key) ?? fail('formula_unknown_measure', `"${key}" is not a measure`);
    if (isFormulaMeasure(measure)) {
      let node = parsed.get(key);
      if (!node) { node = parseFormula(measure.formula); parsed.set(key, node); }
      return emitFormulaSql(node, {
        measure: (ref) => measureSql(ref, bucket, bucketIndex, depth + 1),
        days: bucket ? bucket.days : windowDays,
        ...(view.mode === 'period' ? { periodCount: buckets.length } : {}),
      });
    }
    if (measure.stream !== stream.key) fail('measure_not_on_stream', `"${key}" belongs to stream "${measure.stream}", not "${stream.key}"`);
    if (measure.snapshot) fail('snapshot_measure_unsupported', `"${key}" is a snapshot measure, which is not compiled yet`);
    const column = measure.column === undefined ? '' : `${FACT}.${q(measure.column)}`;
    const call = measure.agg === 'count' ? (column === '' ? 'COUNT(*)' : `COUNT(${column})`)
      : measure.agg === 'count_distinct' ? `COUNT(DISTINCT ${column})`
        : `${measure.agg.toUpperCase()}(${column})`;
    return bucket ? `${call} FILTER (WHERE ${FACT}."__b" = ${bucketIndex})` : call;
  };

  // The select list and the column map, in display order.
  const columns: CompiledColumn[] = [{ name: 'code', kind: 'code', label: groupDim.label }];
  const select: string[] = [`${codeExpr} AS "code"`];
  const grouping = `GROUPING(${codeExpr})`;
  (view.properties ?? []).forEach((property, i) => {
    if (property === 'code') return;
    if ((view.properties ?? []).indexOf(property) !== i) return;
    const expr = `any_value(${propertyOf(groupDim.key, property)})`;
    const name = `prop__${property}`;
    select.push(`${totalRow ? `CASE WHEN ${grouping} = 0 THEN ${expr} END` : expr} AS ${q(name)}`);
    const label = property === 'name' ? 'Name' : groupDim.properties.find((p) => p.key === property)?.label ?? property;
    columns.push({ name, kind: 'property', label, property });
  });
  const display = buckets.map((bucket, i) => ({ bucket, index: i + 1 }));
  if (options.reverse_periods) display.reverse();
  shown.forEach((measure) => {
    display.forEach(({ bucket, index }) => {
      const name = `b${index}__${measure.key}`;
      select.push(`CAST(${measureSql(measure.key, bucket, index, 0)} AS DOUBLE) AS ${q(name)}`);
      columns.push({ name, kind: 'measure', label: `${measure.label} ${bucket.label}`, measure: measure.key, format: measure.format, period: bucket });
    });
    const name = `m__${measure.key}`;
    select.push(`CAST(${measureSql(measure.key, null, 0, 0)} AS DOUBLE) AS ${q(name)}`);
    columns.push({ name, kind: 'measure', label: view.mode === 'period' ? `${measure.label} Total` : measure.label, measure: measure.key, format: measure.format, period: null });
  });
  select.push(`${totalRow ? `CAST(${grouping} AS INTEGER)` : '0'} AS "__total"`);
  columns.push({ name: '__total', kind: 'meta', label: 'Total row' }, { name: '__rows', kind: 'meta', label: 'Row count' });

  // Sort and paging.
  const sort: ViewSort = view.sort ?? { by: `total.${shown[0]?.key ?? ''}`, dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  const sortParts = String(sort.by).split('.');
  const sortName = sortParts[0] === 'code' && sortParts.length === 1 ? 'code'
    : sortParts[0] === 'property' && sortParts.length === 2 ? `prop__${sortParts[1]}`
      : sortParts[0] === 'total' && sortParts.length === 2 ? `m__${sortParts[1]}`
        : sortParts[0] === 'period' && sortParts.length === 3 ? `b${sortParts[1]}__${sortParts[2]}`
          : '';
  if (!columns.some((c) => c.name === sortName && c.kind !== 'meta')) fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  const maxRows = ctx.maxRows ?? ROUTE_MAX_ROWS;
  const limit = view.limit ?? DEFAULT_PAGE_ROWS;
  const offset = view.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit + (totalRow ? 1 : 0) > maxRows) fail('bad_paging', `limit must be a whole number from 1 to ${maxRows - (totalRow ? 1 : 0)}`);
  if (!Number.isInteger(offset) || offset < 0) fail('bad_paging', 'offset must be a whole number, 0 or more');

  // The fact subquery: the date window, and in period mode each row's period number.
  const date = q(stream.date);
  const bucketCase = buckets.length === 0 ? ''
    : `, CASE ${buckets.map((b, i) => `WHEN ${date} < ${sqlDate(b.to)} THEN ${i + 1}`).join(' ')} END AS "__b"`;
  const fact = `(SELECT *${bucketCase} FROM ${q(stream.table)} WHERE ${date} >= ${sqlDate(period.window.from)} AND ${date} < ${sqlDate(period.window.to)}) AS ${FACT}`;

  const sql = [
    'WITH g AS (',
    `SELECT ${select.join(', ')}`,
    `FROM ${fact}`,
    ...joins.values(),
    ...(where.length > 0 ? [`WHERE ${where.join(' AND ')}`] : []),
    totalRow ? `GROUP BY GROUPING SETS ((${codeExpr}), ())` : `GROUP BY ${codeExpr}`,
    '), r AS (',
    `SELECT g.*, row_number() OVER (PARTITION BY "__total" ORDER BY ${q(sortName)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, "code" ASC) AS "__rn",`,
    'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
    'FROM g',
    ')',
    'SELECT * EXCLUDE ("__rn") FROM r',
    `WHERE "__total" = 1 OR ("__rn" > ${offset} AND "__rn" <= ${offset + limit})`,
    'ORDER BY "__total" DESC, "__rn" ASC',
  ].join('\n');

  const maxSqlChars = ctx.maxSqlChars ?? ROUTE_MAX_SQL_CHARS;
  if (sql.length > maxSqlChars) {
    fail('sql_too_long', `the statement is ${sql.length} characters, the limit is ${maxSqlChars}; use fewer periods, measures or selected values`);
  }
  return { ok: true, sql, columns, window: period.window, buckets, months: monthsRange(period.window) };
}

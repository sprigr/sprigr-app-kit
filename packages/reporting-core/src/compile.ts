/**
 * The compiler: a view state in, one DuckDB statement out, plus the column map
 * a grid renders from. The same statement runs through the platform's query
 * route or in DuckDB in the browser.
 *
 * It never decides who may see a column or a row. It runs against whatever
 * tables the caller's role holds.
 *
 * Shape of a grouped statement (period mode, total row on):
 *
 *   WITH g AS (
 *     SELECT <code> AS "code", <properties>, <one column per measure and period>, <totals>
 *     FROM (SELECT *, CASE ... END AS "__b" FROM <fact> WHERE <date window>) AS f
 *     LEFT JOIN <dimension tables>
 *     WHERE <drill path, dimension filters, keyword>
 *     GROUP BY GROUPING SETS ((<code>), ())
 *   ), r AS (<measure filters, row number per sort, row count>)
 *   SELECT ... one page of rows, with the total row first
 *
 * Each period column is an aggregate with `FILTER (WHERE "__b" = n)`, so the
 * date is compared once per row, not once per column. Variance mode reads two
 * windows the same way and adds a stage `v` that subtracts them. Transaction
 * mode lists the fact rows themselves and has no GROUP BY.
 */
import { emitFormulaSql, parseFormula, type FormulaNode } from './formula';
import { isFormulaMeasure, type ModelDimension, type ModelMeasure, type ModelStream, type ReportingModel } from './model';
import { comparisonWindow, daysBetween, monthsRange, resolvePeriod, type PeriodBucket, type PeriodSpec, type PeriodWindow } from './periods';
import { ReportingError, refusalOf, type Refusal, type ReportingReason } from './reasons';
import { likeContains, quoteIdent as q, sqlDate, sqlNumber, sqlString } from './sql';

/** The query route refuses longer SQL (`ANALYTICS_QUERY_MAX_SQL_CHARS` in sprigr-team). */
export const ROUTE_MAX_SQL_CHARS = 24_000;
/** The query route's row cap (`ANALYTICS_QUERY_MAX_ROWS` in sprigr-team). */
export const ROUTE_MAX_ROWS = 2_000;
export const DEFAULT_PAGE_ROWS = 200;
const MAX_KEYWORD_CHARS = 200;
const MAX_FILTER_DEPTH = 3;

export const VIEW_MODES = ['total', 'period', 'variance', 'transaction'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const MEASURE_CMPS = ['=', '<>', '<', '<=', '>', '>='] as const;
/** The four columns a measure has in variance mode. */
export const VARIANCE_PARTS = ['current', 'previous', 'variance', 'variance_pct'] as const;
export type VariancePart = (typeof VARIANCE_PARTS)[number];
export type ViewCompare = 'previous_year' | 'previous_period';

const PART_PREFIX: Record<VariancePart, string> = { current: 'm__', previous: 'prev__', variance: 'var__', variance_pct: 'varp__' };

export interface ViewPathStep { dimension: string; selected: string[] }
export interface ViewDimensionRule { dimension: string; property?: string; cmp: 'in' | 'not_in'; values: string[] }
/**
 * Keeps the rows whose measure passes. It compares the value over the whole
 * period; in variance mode `of` picks which of the four columns.
 */
export interface ViewMeasureRule { measure: string; cmp: string; value: number; of?: VariancePart }
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
  /** Variance mode only: what the period is compared with. `previous_year` when absent. */
  compare?: ViewCompare;
  /** Drill path: each step keeps only the selected codes of one dimension. */
  path?: ViewPathStep[];
  group_by: string;
  /** Properties of the group-by dimension to show: `name` or a property key. The code is always returned. */
  properties?: string[];
  /** Transaction mode only: which of the stream's extra columns to list. All of them when absent. */
  columns?: string[];
  filters?: ViewFilterGroup;
  /** Keeps the members of the group-by dimension whose code or name holds this text. */
  keyword?: string;
  /**
   * `code`, `property.<key>`, `total.<measure>` or `period.<n>.<measure>` (n counts from the oldest period).
   * Variance mode adds `previous.<measure>`, `variance.<measure>` and `variance_pct.<measure>`.
   * Transaction mode takes `date`, `dimension.<key>`, `column.<key>` or `total.<measure>`.
   */
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
  kind: 'code' | 'property' | 'measure' | 'date' | 'dimension' | 'column' | 'meta';
  label: string;
  /** For a property column: its key. */
  property?: string;
  /** For a measure column: the measure key and its format. */
  measure?: string;
  format?: string;
  /** For a measure column: the period it covers, or null for the whole window. */
  period?: PeriodBucket | null;
  /** For a measure column in variance mode: which of the four it is. */
  part?: VariancePart;
  /** For a dimension column in a transaction list: the dimension key. */
  dimension?: string;
  /** For an extra column in a transaction list: its key on the stream. */
  column?: string;
}

export interface CompiledView {
  ok: true;
  sql: string;
  columns: CompiledColumn[];
  window: PeriodWindow;
  /** Variance mode: the window the period is compared with. */
  comparison?: PeriodWindow;
  buckets: PeriodBucket[];
  /** Inclusive `YYYY-MM` range the statement reads, for the query route's `months` argument. */
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
    if (!(VIEW_MODES as readonly string[]).includes(view.mode)) fail('mode_unsupported', `mode "${String(view.mode)}" is not compiled yet`);
    return view.mode === 'transaction' ? compileTransactions(model, view, ctx) : compileGrouped(model, view, ctx);
  } catch (err) {
    return refusalOf(err);
  }
}

type LeafRule = ViewDimensionRule | ViewMeasureRule;

/** What every mode needs from a view: its stream, dimensions resolved to SQL, and its filters. */
interface Scope {
  stream: ModelStream;
  measureByKey: Map<string, ModelMeasure>;
  /** Joins the expressions below rely on, in the order they must be written. */
  joins: Map<string, string>;
  dimension: (key: string) => ModelDimension;
  propertyOf: (dimKey: string, property: string) => string;
  groupDim: ModelDimension;
  codeExpr: string;
  /** Conditions on fact rows: the drill path, dimension filters and the keyword. */
  where: string[];
  /** The condition measure filters put on grouped rows, or null. */
  having: string | null;
  /** Keys of the measures that condition reads. */
  filterMeasures: string[];
  /** Set when the view also lists members with nothing in the period. */
  members: MemberList | null;
}

/** The group-by dimension's own table, aliased "mb": one row per member, whether or not it has fact rows. */
interface MemberList {
  table: string;
  /** The member's code, read from that table. */
  code: string;
  joins: string[];
  /** Which members to list: the keyword, and the path steps and filters the member's own table can answer. */
  conds: string[];
  property: (property: string) => string;
}

function scopeOf(model: ReportingModel, view: ViewState, withMembers = false): Scope {
  const stream: ModelStream = model.streams.find((s) => s.key === view.stream) ?? fail('unknown_stream', `no stream "${String(view.stream)}"`);
  const dimByKey = new Map(model.dimensions.map((d) => [d.key, d]));
  const measureByKey = new Map(model.measures.map((m) => [m.key, m]));

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
  const columnOf = (dim: ModelDimension, property: string): string => {
    const column = property === 'name' ? dim.name : dim.properties.find((p) => p.key === property)?.column;
    return column ?? fail('unknown_property', `"${dim.key}" has no property "${String(property)}"`);
  };
  const propertyOf = (dimKey: string, property: string): string => {
    const code = codeOf(dimKey);
    if (property === 'code') return code;
    const dim = dimension(dimKey);
    const column = columnOf(dim, property);
    return `${join(dim, code)}.${q(column)}`;
  };

  const groupDim = dimension(view.group_by);
  const codeExpr = codeOf(groupDim.key);

  // The member list resolves a dimension from the group-by dimension's own table instead of from a fact row.
  const membersOf = () => {
    const table = groupDim.table;
    const codeColumn = groupDim.code;
    if (!table || !codeColumn) fail('dimension_has_no_table', `"${groupDim.key}" has no table to list its members from`);
    const root = q('mb');
    const joinsHere = new Map<string, string>();
    /** True when the member's table can answer for a dimension: it is the group-by dimension or one above it. */
    const reaches = (key: string, depth = 0): boolean => {
      if (key === groupDim.key) return true;
      const via = dimByKey.get(key)?.via;
      return via !== undefined && depth < 20 && reaches(via.dimension, depth + 1);
    };
    const tableOf = (dim: ModelDimension, code: string): string => {
      if (dim.key === groupDim.key) return root;
      if (!dim.table || !dim.code) fail('dimension_has_no_table', `"${dim.key}" has no table to read from`);
      const a = q(`mb_${dim.key}`);
      if (!joinsHere.has(a)) joinsHere.set(a, `LEFT JOIN ${q(dim.table)} AS ${a} ON ${a}.${q(dim.code)} = ${code}`);
      return a;
    };
    const codeHere = (key: string): string => {
      const dim = dimension(key);
      if (dim.key === groupDim.key) return `${root}.${q(codeColumn)}`;
      const via = dim.via ?? fail('dimension_not_on_stream', `"${key}" is not above "${groupDim.key}"`);
      const parent = dimension(via.dimension);
      return `${tableOf(parent, codeHere(parent.key))}.${q(via.column)}`;
    };
    const propertyHere = (dimKey: string, property: string): string => {
      const code = codeHere(dimKey);
      if (property === 'code') return code;
      const dim = dimension(dimKey);
      const column = columnOf(dim, property);
      return `${tableOf(dim, code)}.${q(column)}`;
    };
    const conds: string[] = [];
    return { table, joinsHere, reaches, codeHere, propertyHere, conds };
  };
  const mb = withMembers ? membersOf() : null;

  // The drill path.
  const where: string[] = [];
  const inList = (values: string[]): string => `(${values.map(sqlString).join(', ')})`;
  (view.path ?? []).forEach((step) => {
    const values = stringList(step?.selected, `the drill step on "${String(step?.dimension)}"`);
    where.push(`CAST(${codeOf(step.dimension)} AS VARCHAR) IN ${inList(values)}`);
    if (mb && mb.reaches(step.dimension)) mb.conds.push(`CAST(${mb.codeHere(step.dimension)} AS VARCHAR) IN ${inList(values)}`);
  });

  // Filters. A dimension rule tests fact rows; a measure rule tests grouped rows.
  const filterMeasures: string[] = [];
  const dimensionLeafWith = (resolve: (dimKey: string, property: string) => string) => (rule: LeafRule): string => {
    if ('measure' in rule) fail('measure_filter_unsupported', 'a measure rule cannot sit in a group of dimension rules');
    if (rule.cmp !== 'in' && rule.cmp !== 'not_in') fail('empty_filter', `"${String(rule.cmp)}" is not a filter comparison`);
    const expr = resolve(rule.dimension, rule.property ?? 'code');
    const values = inList(stringList(rule.values, `the filter on "${String(rule.dimension)}"`));
    return rule.cmp === 'in'
      ? `CAST(${expr} AS VARCHAR) IN ${values}`
      : `(${expr} IS NULL OR CAST(${expr} AS VARCHAR) NOT IN ${values})`;
  };
  const dimensionLeaf = dimensionLeafWith(propertyOf);
  const measureLeaf = (rule: LeafRule): string => {
    if (!('measure' in rule)) fail('measure_filter_unsupported', 'a dimension rule cannot sit in a group of measure rules');
    if (!(MEASURE_CMPS as readonly string[]).includes(rule.cmp)) fail('measure_filter_unsupported', `"${String(rule.cmp)}" is not a comparison`);
    const part: VariancePart = rule.of ?? 'current';
    if (!(VARIANCE_PARTS as readonly string[]).includes(part)) fail('measure_filter_unsupported', `"${String(part)}" is not a variance column`);
    if (part !== 'current' && view.mode !== 'variance') fail('measure_filter_unsupported', `"${part}" exists in variance mode only`);
    const measure = measureByKey.get(rule.measure) ?? fail('unknown_measure', `no measure "${String(rule.measure)}"`);
    if (!filterMeasures.includes(measure.key)) filterMeasures.push(measure.key);
    return `${q(`${PART_PREFIX[part]}${measure.key}`)} ${rule.cmp} ${sqlNumber(rule.value)}`;
  };
  const kindOf = (rule: LeafRule | ViewFilterGroup, depth: number): 'dimension' | 'measure' => {
    if (!isGroup(rule)) return 'measure' in rule ? 'measure' : 'dimension';
    if (depth > MAX_FILTER_DEPTH) fail('filter_too_deep', `filters nest deeper than ${MAX_FILTER_DEPTH} levels`);
    const kinds = new Set((Array.isArray(rule.rules) ? rule.rules : []).map((r) => kindOf(r, depth + 1)));
    if (kinds.size > 1) fail('measure_filter_unsupported', 'below the top level a filter group holds dimension rules or measure rules, not both');
    return kinds.has('measure') ? 'measure' : 'dimension';
  };
  const groupSql = (group: ViewFilterGroup, depth: number, leaf: (rule: LeafRule) => string): string => {
    if (depth > MAX_FILTER_DEPTH) fail('filter_too_deep', `filters nest deeper than ${MAX_FILTER_DEPTH} levels`);
    if (group.op !== 'and' && group.op !== 'or') fail('empty_filter', 'a filter group needs op "and" or "or"');
    const rules = Array.isArray(group.rules) ? group.rules : [];
    if (rules.length === 0) fail('empty_filter', 'a filter group has no rules');
    const parts = rules.map((rule) => (isGroup(rule) ? groupSql(rule, depth + 1, leaf) : leaf(rule)));
    return `(${parts.join(group.op === 'and' ? ' AND ' : ' OR ')})`;
  };
  let having: string | null = null;
  if (view.filters) {
    const top = view.filters;
    if (top.op !== 'and' && top.op !== 'or') fail('empty_filter', 'a filter group needs op "and" or "or"');
    const rules = Array.isArray(top.rules) ? top.rules : [];
    const onRows = rules.filter((rule) => kindOf(rule, 1) === 'dimension');
    const onGroups = rules.filter((rule) => kindOf(rule, 1) === 'measure');
    if (onRows.length > 0 && onGroups.length > 0 && top.op === 'or') {
      fail('measure_filter_unsupported', 'dimension rules and measure rules combine with "and" only');
    }
    if (onRows.length > 0) where.push(groupSql({ op: top.op, rules: onRows }, 0, dimensionLeaf));
    if (onGroups.length > 0) having = groupSql({ op: top.op, rules: onGroups }, 0, measureLeaf);
    if (mb && onRows.length > 0) {
      const answerable = (rule: LeafRule | ViewFilterGroup): boolean => (
        isGroup(rule) ? rule.rules.every(answerable) : !('measure' in rule) && mb.reaches(rule.dimension)
      );
      const mine = onRows.filter(answerable);
      // Under "or", one rule the member's table cannot answer leaves the member list open.
      if (mine.length > 0 && (top.op === 'and' || mine.length === onRows.length)) {
        mb.conds.push(groupSql({ op: top.op, rules: mine }, 0, dimensionLeafWith(mb.propertyHere)));
      }
    }
  }

  // The keyword.
  const keyword = typeof view.keyword === 'string' ? view.keyword.trim() : '';
  if (keyword.length > MAX_KEYWORD_CHARS) fail('keyword_too_long', `the keyword is longer than ${MAX_KEYWORD_CHARS} characters`);
  if (keyword !== '') {
    const pattern = `${likeContains(keyword)} ESCAPE '\\'`;
    const targets = [`CAST(${codeExpr} AS VARCHAR) ILIKE ${pattern}`];
    if (groupDim.table && groupDim.name) targets.push(`${propertyOf(groupDim.key, 'name')} ILIKE ${pattern}`);
    where.push(`(${targets.join(' OR ')})`);
    if (mb) {
      const mine = [`CAST(${mb.codeHere(groupDim.key)} AS VARCHAR) ILIKE ${pattern}`];
      if (groupDim.name) mine.push(`${mb.propertyHere(groupDim.key, 'name')} ILIKE ${pattern}`);
      mb.conds.push(`(${mine.join(' OR ')})`);
    }
  }

  const members: MemberList | null = mb && {
    table: mb.table,
    code: mb.codeHere(groupDim.key),
    joins: [...mb.joinsHere.values()],
    conds: mb.conds,
    property: (property) => mb.propertyHere(groupDim.key, property),
  };
  return { stream, measureByKey, joins, dimension, propertyOf, groupDim, codeExpr, where, having, filterMeasures, members };
}

function shownMeasures(view: ViewState, measureByKey: Map<string, ModelMeasure>): ModelMeasure[] {
  if (!Array.isArray(view.measures) || view.measures.length === 0) fail('no_measures', 'a view needs at least one measure');
  return view.measures.map((key, i) => {
    if (view.measures.indexOf(key) !== i) fail('duplicate_measure', `"${String(key)}" is listed twice`);
    return measureByKey.get(key) ?? fail('unknown_measure', `no measure "${String(key)}"`);
  });
}

function pageOf(view: ViewState, ctx: CompileContext, reserved: number): { limit: number; offset: number } {
  const maxRows = ctx.maxRows ?? ROUTE_MAX_ROWS;
  const limit = view.limit ?? DEFAULT_PAGE_ROWS;
  const offset = view.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit + reserved > maxRows) fail('bad_paging', `limit must be a whole number from 1 to ${maxRows - reserved}`);
  if (!Number.isInteger(offset) || offset < 0) fail('bad_paging', 'offset must be a whole number, 0 or more');
  return { limit, offset };
}

function checkLength(sql: string, ctx: CompileContext): void {
  const maxSqlChars = ctx.maxSqlChars ?? ROUTE_MAX_SQL_CHARS;
  if (sql.length > maxSqlChars) {
    fail('sql_too_long', `the statement is ${sql.length} characters, the limit is ${maxSqlChars}; use fewer periods, measures or selected values`);
  }
}

/**
 * One window of dates a measure is computed over: the condition that picks its
 * fact rows, and the one that picks the rows of its latest day (for a snapshot measure).
 */
interface Slice { bucket: PeriodBucket; filter: string; last: string }

/** Total, period and variance modes: one row per member of the group-by dimension. */
function compileGrouped(model: ReportingModel, view: ViewState, ctx: CompileContext): CompiledView {
  const options: ViewOptions = view.options ?? {};
  const activity = options.activity ?? 'with';
  if (activity !== 'with' && activity !== 'without' && activity !== 'all') fail('option_unsupported', `"${String(activity)}" is not an activity option`);
  if (options.others_row || options.average_row) fail('option_unsupported', 'others and average rows are not compiled yet');
  // Members with no activity have no figures, so a list of them has no total row.
  const totalRow = options.total_row === true && activity !== 'without';

  const scope = scopeOf(model, view, activity !== 'with');
  const { stream, measureByKey, joins, groupDim, where, members } = scope;
  // With the member list joined in, a row's code comes from whichever side has it.
  const codeExpr = members ? `COALESCE(${members.code}, ${FACT}."__code")` : scope.codeExpr;
  const shown = shownMeasures(view, measureByKey);
  // A measure a filter reads but the view does not show is computed, then left out of the result.
  const unseen = scope.filterMeasures
    .filter((key) => !view.measures.includes(key))
    .map((key) => measureByKey.get(key) ?? fail('unknown_measure', `no measure "${key}"`));

  // Periods, and the fact subquery that reads them.
  const period = resolvePeriod(view.period, model.periods, ctx.today, { periodToDate: options.period_to_date === true });
  const buckets = view.mode === 'period' ? period.buckets : [];
  const windowDays = period.buckets.reduce((sum, b) => sum + b.days, 0);
  const date = q(stream.date);
  const inWindow = (w: PeriodWindow): string => `${date} >= ${sqlDate(w.from)} AND ${date} < ${sqlDate(w.to)}`;
  const slices: Slice[] = buckets.map((bucket, i) => ({
    bucket,
    filter: `${FACT}."__b" = ${i + 1}`,
    last: `${FACT}."__b" = ${i + 1} AND ${FACT}."__last"`,
  }));
  let factColumns = buckets.length === 0 ? ''
    : `, CASE ${buckets.map((b, i) => `WHEN ${date} < ${sqlDate(b.to)} THEN ${i + 1}`).join(' ')} END AS "__b"`;
  let factWhere = inWindow(period.window);
  // Variance mode: the value over the whole period is the current window's, beside the earlier window's.
  let current: Slice | null = null;
  let previous: Slice | null = null;
  let comparison: PeriodWindow | null = null;
  if (view.mode === 'variance') {
    const compare = view.compare ?? 'previous_year';
    if (compare !== 'previous_year' && compare !== 'previous_period') fail('option_unsupported', `"${String(compare)}" is not a comparison`);
    comparison = comparisonWindow(period.window, compare);
    const whole = (key: string, label: string, w: PeriodWindow): PeriodBucket => ({ key, label, from: w.from, to: w.to, days: daysBetween(w.from, w.to) });
    current = { bucket: whole('current', 'Current', period.window), filter: `${FACT}."__cur"`, last: `${FACT}."__lastc"` };
    previous = {
      bucket: whole('previous', compare === 'previous_year' ? 'Previous year' : 'Previous period', comparison),
      filter: `${FACT}."__prev"`,
      last: `${FACT}."__lastp"`,
    };
    // Two flags, not one number: a period longer than a year overlaps the year before it.
    factColumns = `, (${inWindow(period.window)}) AS "__cur", (${inWindow(comparison)}) AS "__prev"`;
    factWhere = `(${inWindow(period.window)}) OR (${inWindow(comparison)})`;
  }

  // Measures: an aggregate for a base measure, the formula over those aggregates otherwise.
  const uses = new Set<'snapshot'>();
  const parsed = new Map<string, FormulaNode>();
  const measureSql = (key: string, slice: Slice | null, depth: number): string => {
    if (depth > 20) fail('formula_cycle', `"${key}" refers back to itself`);
    const measure = measureByKey.get(key) ?? fail('formula_unknown_measure', `"${key}" is not a measure`);
    if (isFormulaMeasure(measure)) {
      let node = parsed.get(key);
      if (!node) { node = parseFormula(measure.formula); parsed.set(key, node); }
      return emitFormulaSql(node, {
        measure: (ref) => measureSql(ref, slice, depth + 1),
        days: slice ? slice.bucket.days : windowDays,
        ...(view.mode === 'period' ? { periodCount: buckets.length } : {}),
      });
    }
    if (measure.stream !== stream.key) fail('measure_not_on_stream', `"${key}" belongs to stream "${measure.stream}", not "${stream.key}"`);
    const column = measure.column === undefined ? '' : `${FACT}.${q(measure.column)}`;
    // A member with no fact rows still has one row in the join, which a bare COUNT(*) would count.
    const call = measure.agg === 'count' ? (column !== '' ? `COUNT(${column})` : members ? `COUNT(${FACT}."__in")` : 'COUNT(*)')
      : measure.agg === 'count_distinct' ? `COUNT(DISTINCT ${column})`
        : `${measure.agg.toUpperCase()}(${column})`;
    // A level, not a flow: only the rows of the window's latest day count.
    if (measure.snapshot) {
      uses.add('snapshot');
      return `${call} FILTER (WHERE ${slice ? slice.last : `${FACT}."__lastw"`})`;
    }
    return slice ? `${call} FILTER (WHERE ${slice.filter})` : call;
  };

  // The select list and the column map, in display order.
  const columns: CompiledColumn[] = [{ name: 'code', kind: 'code', label: groupDim.label }];
  const select: string[] = [`${codeExpr} AS "code"`];
  const grouping = `GROUPING(${codeExpr})`;
  (view.properties ?? []).forEach((property, i) => {
    if (property === 'code') return;
    if ((view.properties ?? []).indexOf(property) !== i) return;
    const expr = `any_value(${members ? members.property(property) : scope.propertyOf(groupDim.key, property)})`;
    const name = `prop__${property}`;
    select.push(`${totalRow ? `CASE WHEN ${grouping} = 0 THEN ${expr} END` : expr} AS ${q(name)}`);
    const label = property === 'name' ? 'Name' : groupDim.properties.find((p) => p.key === property)?.label ?? property;
    columns.push({ name, kind: 'property', label, property });
  });
  const display = slices.map((slice, i) => ({ slice, index: i + 1 }));
  if (options.reverse_periods) display.reverse();
  /** Variance columns. They are computed from g's own columns in stage v, so no aggregate is written twice. */
  const derived: string[] = [];
  const left: string[] = ['__rn'];
  const put = (into: string[], name: string, expr: string, seen: boolean, column: Omit<CompiledColumn, 'name' | 'kind'>): void => {
    into.push(`${expr} AS ${q(name)}`);
    if (seen) columns.push({ name, kind: 'measure', ...column });
    else left.push(name);
  };
  const double = (expr: string): string => `CAST(${expr} AS DOUBLE)`;
  const addMeasure = (measure: ModelMeasure, seen: boolean): void => {
    const about = { measure: measure.key, format: measure.format };
    if (seen) {
      display.forEach(({ slice, index }) => {
        put(select, `b${index}__${measure.key}`, double(measureSql(measure.key, slice, 0)), true,
          { ...about, label: `${measure.label} ${slice.bucket.label}`, period: slice.bucket });
      });
    }
    const wholeName = `m__${measure.key}`;
    put(select, wholeName, double(measureSql(measure.key, current, 0)), seen, {
      ...about,
      label: view.mode === 'period' ? `${measure.label} Total` : measure.label,
      period: current ? current.bucket : null,
      ...(current ? { part: 'current' as const } : {}),
    });
    if (!current || !previous) return;
    const cur = q(wholeName);
    const prev = q(`prev__${measure.key}`);
    put(select, `prev__${measure.key}`, double(measureSql(measure.key, previous, 0)), seen,
      { ...about, label: `${measure.label} ${previous.bucket.label}`, period: previous.bucket, part: 'previous' });
    // A member with nothing in one window still has a variance: the blank counts as 0.
    put(derived, `var__${measure.key}`, `COALESCE(${cur}, 0) - COALESCE(${prev}, 0)`, seen,
      { ...about, label: `${measure.label} Variance`, period: null, part: 'variance' });
    put(derived, `varp__${measure.key}`, `(COALESCE(${cur}, 0) - ${prev}) / NULLIF(abs(${prev}), 0)`, seen,
      { measure: measure.key, format: 'percent', label: `${measure.label} Variance %`, period: null, part: 'variance_pct' });
  };
  shown.forEach((measure) => addMeasure(measure, true));
  unseen.forEach((measure) => addMeasure(measure, false));
  select.push(`${totalRow ? `CAST(${grouping} AS INTEGER)` : '0'} AS "__total"`);
  columns.push({ name: '__total', kind: 'meta', label: 'Total row' }, { name: '__rows', kind: 'meta', label: 'Row count' });

  // Sort and paging.
  const sort: ViewSort = view.sort ?? { by: `total.${shown[0]?.key ?? ''}`, dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  const sortParts = String(sort.by).split('.');
  const two = sortParts.length === 2;
  const sortName = sortParts[0] === 'code' && sortParts.length === 1 ? 'code'
    : sortParts[0] === 'property' && two ? `prop__${sortParts[1]}`
      : sortParts[0] === 'total' && two ? `m__${sortParts[1]}`
        : sortParts[0] === 'previous' && two ? `prev__${sortParts[1]}`
          : sortParts[0] === 'variance' && two ? `var__${sortParts[1]}`
            : sortParts[0] === 'variance_pct' && two ? `varp__${sortParts[1]}`
              : sortParts[0] === 'period' && sortParts.length === 3 ? `b${sortParts[1]}__${sortParts[2]}`
                : '';
  if (!columns.some((c) => c.name === sortName && c.kind !== 'meta')) fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  const { limit, offset } = pageOf(view, ctx, totalRow ? 1 : 0);

  // The fact subquery. A snapshot measure needs each window's latest day, the same day for every member,
  // so it is found here, before any filter narrows the rows.
  const rows = `SELECT *${factColumns} FROM ${q(stream.table)} WHERE ${factWhere}`;
  const latest = (over: string): string => `${date} = MAX(${date}) ${over}`;
  const lastColumns = view.mode === 'variance'
    ? `("__cur" AND ${latest('FILTER (WHERE "__cur") OVER ()')}) AS "__lastc", ("__prev" AND ${latest('FILTER (WHERE "__prev") OVER ()')}) AS "__lastp"`
    : `${buckets.length > 0 ? `(${latest('OVER (PARTITION BY "__b")')}) AS "__last", ` : ''}(${latest('OVER ()')}) AS "__lastw"`;
  const fact = uses.has('snapshot') ? `(SELECT *, ${lastColumns} FROM (${rows}) AS s) AS ${FACT}` : `(${rows}) AS ${FACT}`;
  const factRows = [`FROM ${fact}`, ...joins.values(), ...(where.length > 0 ? [`WHERE ${where.join(' AND ')}`] : [])];
  // With the member list, the filtered fact rows become a subquery joined to the dimension's own table:
  // "all" keeps both sides, "without" keeps the members no fact row matched.
  const from = !members ? factRows : [
    `FROM ${q(members.table)} AS "mb"`,
    `${activity === 'all' ? 'FULL' : 'LEFT'} JOIN (`,
    `SELECT ${FACT}.*, ${scope.codeExpr} AS "__code", 1 AS "__in"`,
    ...factRows,
    `) AS ${FACT} ON ${FACT}."__code" = ${members.code}`,
    ...members.joins,
    ...(members.conds.length > 0 ? [`WHERE ${FACT}."__in" IS NOT NULL OR (${members.conds.join(' AND ')})`] : []),
  ];

  // A measure filter drops rows after grouping and never drops the total row, which stays the total of every member.
  const source = derived.length > 0 ? 'v' : 'g';
  const sql = [
    'WITH g AS (',
    `SELECT ${select.join(', ')}`,
    ...from,
    totalRow ? `GROUP BY GROUPING SETS ((${codeExpr}), ())` : `GROUP BY ${codeExpr}`,
    ...(activity === 'without' ? [`HAVING COUNT(${FACT}."__in") = 0`] : []),
    ...(source === 'v' ? ['), v AS (', `SELECT g.*, ${derived.join(', ')}`, 'FROM g'] : []),
    '), r AS (',
    `SELECT ${source}.*, row_number() OVER (PARTITION BY "__total" ORDER BY ${q(sortName)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, "code" ASC) AS "__rn",`,
    'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
    `FROM ${source}`,
    ...(scope.having !== null ? [`WHERE "__total" = 1 OR ${scope.having}`] : []),
    ')',
    `SELECT * EXCLUDE (${left.map(q).join(', ')}) FROM r`,
    `WHERE "__total" = 1 OR ("__rn" > ${offset} AND "__rn" <= ${offset + limit})`,
    'ORDER BY "__total" DESC, "__rn" ASC',
  ].join('\n');
  checkLength(sql, ctx);

  const read: PeriodWindow = comparison && comparison.from < period.window.from
    ? { from: comparison.from, to: period.window.to }
    : period.window;
  return {
    ok: true,
    sql,
    columns,
    window: period.window,
    ...(comparison ? { comparison } : {}),
    buckets,
    months: monthsRange(read),
  };
}

/** Transaction mode: the fact rows themselves, newest first, one page at a time. */
function compileTransactions(model: ReportingModel, view: ViewState, ctx: CompileContext): CompiledView {
  const options: ViewOptions = view.options ?? {};
  if (options.activity !== undefined && options.activity !== 'with') fail('option_unsupported', 'a transaction list shows rows that exist; activity does not apply');
  if (options.total_row || options.others_row || options.average_row) fail('option_unsupported', 'a transaction list has no total, others or average row');

  const scope = scopeOf(model, view);
  const { stream, measureByKey } = scope;
  if (scope.having !== null) fail('measure_filter_unsupported', 'a transaction list cannot be filtered on a measure');
  const shown = shownMeasures(view, measureByKey);
  const period = resolvePeriod(view.period, model.periods, ctx.today, { periodToDate: options.period_to_date === true });
  const windowDays = period.buckets.reduce((sum, b) => sum + b.days, 0);

  // On one row an aggregate is the row's own value, and a count is 1.
  const parsed = new Map<string, FormulaNode>();
  const rowSql = (key: string, depth: number): string => {
    if (depth > 20) fail('formula_cycle', `"${key}" refers back to itself`);
    const measure = measureByKey.get(key) ?? fail('formula_unknown_measure', `"${key}" is not a measure`);
    if (isFormulaMeasure(measure)) {
      let node = parsed.get(key);
      if (!node) { node = parseFormula(measure.formula); parsed.set(key, node); }
      return emitFormulaSql(node, { measure: (ref) => rowSql(ref, depth + 1), days: windowDays });
    }
    if (measure.stream !== stream.key) fail('measure_not_on_stream', `"${key}" belongs to stream "${measure.stream}", not "${stream.key}"`);
    if (measure.snapshot) fail('snapshot_measure_unsupported', `"${key}" is a snapshot measure, which is not compiled yet`);
    const column = measure.column === undefined ? '' : `${FACT}.${q(measure.column)}`;
    if (measure.agg === 'count' || measure.agg === 'count_distinct') return column === '' ? '1' : `(CASE WHEN ${column} IS NULL THEN 0 ELSE 1 END)`;
    return column;
  };

  // The date as text, so both engines hand back the same thing.
  const date = q(stream.date);
  const columns: CompiledColumn[] = [{ name: 'date', kind: 'date', label: 'Date' }];
  const select: string[] = [`CAST(CAST(${FACT}.${date} AS DATE) AS VARCHAR) AS "date"`];
  Object.entries(stream.dimension_keys).forEach(([key, column]) => {
    const name = `dim__${key}`;
    select.push(`${FACT}.${q(column)} AS ${q(name)}`);
    columns.push({ name, kind: 'dimension', label: scope.dimension(key).label, dimension: key });
  });
  const wanted = view.columns ?? stream.columns.map((c) => c.key);
  if (!Array.isArray(wanted)) fail('unknown_column', 'columns must be a list of column keys');
  wanted.forEach((key, i) => {
    if (wanted.indexOf(key) !== i) return;
    const extra = stream.columns.find((c) => c.key === key) ?? fail('unknown_column', `stream "${stream.key}" has no column "${String(key)}"`);
    const name = `col__${extra.key}`;
    select.push(`${FACT}.${q(extra.column)} AS ${q(name)}`);
    columns.push({ name, kind: 'column', label: extra.label, column: extra.key });
  });
  shown.forEach((measure) => {
    const name = `m__${measure.key}`;
    select.push(`CAST(${rowSql(measure.key, 0)} AS DOUBLE) AS ${q(name)}`);
    columns.push({ name, kind: 'measure', label: measure.label, measure: measure.key, format: measure.format, period: null });
  });

  // Sort by one column, then by every other, so the same row lands on the same page each time.
  const sort: ViewSort = view.sort ?? { by: 'date', dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  const sortParts = String(sort.by).split('.');
  const two = sortParts.length === 2;
  const sortName = sortParts[0] === 'date' && sortParts.length === 1 ? 'date'
    : sortParts[0] === 'dimension' && two ? `dim__${sortParts[1]}`
      : sortParts[0] === 'column' && two ? `col__${sortParts[1]}`
        : sortParts[0] === 'total' && two ? `m__${sortParts[1]}`
          : '';
  if (!columns.some((c) => c.name === sortName)) fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  const order = [
    `${q(sortName)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`,
    ...columns.filter((c) => c.name !== sortName).map((c) => `${q(c.name)} ASC`),
  ];
  columns.push({ name: '__rows', kind: 'meta', label: 'Row count' });
  const { limit, offset } = pageOf(view, ctx, 0);

  const sql = [
    'WITH g AS (',
    `SELECT ${select.join(', ')}`,
    `FROM (SELECT * FROM ${q(stream.table)} WHERE ${date} >= ${sqlDate(period.window.from)} AND ${date} < ${sqlDate(period.window.to)}) AS ${FACT}`,
    ...scope.joins.values(),
    ...(scope.where.length > 0 ? [`WHERE ${scope.where.join(' AND ')}`] : []),
    '), r AS (',
    `SELECT g.*, row_number() OVER (ORDER BY ${order.join(', ')}) AS "__rn",`,
    'CAST(count(*) OVER () AS INTEGER) AS "__rows"',
    'FROM g',
    ')',
    'SELECT * EXCLUDE ("__rn") FROM r',
    `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limit}`,
    'ORDER BY "__rn" ASC',
  ].join('\n');
  checkLength(sql, ctx);

  return { ok: true, sql, columns, window: period.window, buckets: [], months: monthsRange(period.window) };
}

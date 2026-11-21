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
 * mode lists the fact rows themselves and has no GROUP BY. Stream mode groups
 * each stream in its own stage and folds the stages into one row per member.
 * Matrix mode groups by two dimensions and returns one row per cell.
 */
import { emitFormulaSql, parseFormula, type FormulaNode } from './formula';
import { isFormulaMeasure, type ModelBaseMeasure, type ModelDimension, type ModelMeasure, type ModelRollup, type ModelStream, type ReportingModel } from './model';
import { comparisonWindow, daysBetween, monthsRange, resolvePeriod, type PeriodBucket, type PeriodSpec, type PeriodWindow } from './periods';
import { ReportingError, refusalOf, type Refusal, type ReportingReason } from './reasons';
import { likeContains, quoteIdent as q, sqlDate, sqlNumber, sqlString, tablesIn } from './sql';

/** The query route refuses longer SQL (`ANALYTICS_QUERY_MAX_SQL_CHARS` in sprigr-team). */
export const ROUTE_MAX_SQL_CHARS = 24_000;
/** The query route's row cap (`ANALYTICS_QUERY_MAX_ROWS` in sprigr-team). */
export const ROUTE_MAX_ROWS = 2_000;
export const DEFAULT_PAGE_ROWS = 200;
/** How many columns a matrix keeps when the view does not say. */
export const DEFAULT_ACROSS_MEMBERS = 12;
const MAX_KEYWORD_CHARS = 200;
const MAX_FILTER_DEPTH = 3;

export const VIEW_MODES = ['total', 'period', 'variance', 'transaction', 'stream', 'matrix'] as const;
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
/**
 * Matrix mode: the dimension whose members become columns. `limit` is how many to keep.
 * `order` picks them: `value` keeps those with the largest total of the first measure, `code` the first by code.
 */
export interface ViewAcross { dimension: string; limit?: number; order?: 'value' | 'code' }
export interface ViewOptions {
  activity?: 'with' | 'without' | 'all';
  total_row?: boolean;
  /** One row for the members a drill step on the group-by dimension leaves out. `__total` is 2 on it. */
  others_row?: boolean;
  /** One row holding the mean of each measure column over the member rows. `__total` is 3 on it. */
  average_row?: boolean;
  /** One row holding the sum of each measure column over the member rows, a ratio included. `__total` is 4 on it. */
  sum_row?: boolean;
  period_to_date?: boolean;
  /** Newest period first. Changes column order only. */
  reverse_periods?: boolean;
  /** Period mode: one more column a measure, the mean of its period columns. Blank periods are skipped. */
  average_column?: boolean;
  /** Leaves out the rows whose every shown figure over the whole period is zero or blank. The total still counts them. */
  hide_zero_rows?: boolean;
}

/** What a saved view stores. */
export interface ViewState {
  mode: string;
  /** The stream the view reads. Stream mode also reads every other stream its measures belong to. */
  stream: string;
  measures: string[];
  period: PeriodSpec;
  /** Variance mode only: what the period is compared with. `previous_year` when absent. */
  compare?: ViewCompare;
  /** Drill path: each step keeps only the selected codes of one dimension. */
  path?: ViewPathStep[];
  group_by: string;
  /** Matrix mode only: the second dimension. */
  across?: ViewAcross;
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
   * Period mode with `average_column` adds `average.<measure>`.
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
  /**
   * Period mode: `wide` is one column per period, `long` one row per member and period.
   * When absent, the view goes long only if its wide statement is over `maxSqlChars`.
   */
  periodShape?: 'wide' | 'long';
}

export interface CompiledColumn {
  /** The column's name in the result. */
  name: string;
  kind: 'code' | 'property' | 'measure' | 'date' | 'dimension' | 'column' | 'across' | 'meta';
  label: string;
  /** For a property column: its key. */
  property?: string;
  /** For a measure column: the measure key and its format. */
  measure?: string;
  format?: string;
  /** For a measure column: the period it covers, or null for the whole window. */
  period?: PeriodBucket | null;
  /** For a measure column in period mode: true on the mean of the measure's period columns. */
  average?: boolean;
  /** For a measure column in variance mode: which of the four it is. */
  part?: VariancePart;
  /** For a dimension column in a transaction list, or the column dimension of a matrix: the dimension key. */
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
  /**
   * Every table the statement reads, fact or rollup tables and dimension tables, in the order it
   * first reads them. A caller that holds its own copy of the data loads these.
   */
  tables: string[];
  /** Stream mode: the streams the statement reads, the view's own first. */
  streams?: string[];
  /** Matrix mode: the column dimension and how many of its members the result keeps. */
  across?: { dimension: string; limit: number };
  /**
   * `long` when the result has one row per cell and the grid must pivot it: matrix mode, and a period view
   * too long for one column per period. In that period view `across` is the period's number, from the oldest.
   */
  shape?: 'long';
  /** With `shape`, in a period view: true when column 1 is the newest period (`options.reverse_periods`). */
  reversed?: true;
  /** With `shape`: the rows a page holds, fitted to the row cap. It can be fewer than the view asked for. */
  limit?: number;
  /** From `compileRollupView`: the rollup each stream is read from, in the order the statement reads them. */
  rollups?: CompiledRollup[];
}

export interface CompiledRollup { stream: string; rollup: string; table: string }

/** What each mode's compiler returns; `compileView` adds the table list. */
type Compiled = Omit<CompiledView, 'tables'>;

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
    const out = compileMode(model, view, ctx);
    // Only a name the model gives a table counts, whatever else the statement text holds.
    const known = new Set([...model.streams.map((s) => s.table), ...model.dimensions.flatMap((d) => (d.table ? [d.table] : []))]);
    return { ...out, tables: tablesIn(out.sql).filter((table) => known.has(table)) };
  } catch (err) {
    return refusalOf(err);
  }
}

function compileMode(model: ReportingModel, view: ViewState, ctx: CompileContext): Compiled {
  if (!(VIEW_MODES as readonly string[]).includes(view.mode)) fail('mode_unsupported', `mode "${String(view.mode)}" is not compiled yet`);
  if (view.mode === 'transaction') return compileTransactions(model, view, ctx);
  if (view.mode === 'stream') return compileStreams(model, view, ctx);
  if (view.mode === 'matrix') return compileMatrix(model, view, ctx);
  if (view.mode !== 'period' || ctx.periodShape === 'wide') return compileGrouped(model, view, ctx);
  if (ctx.periodShape === 'long') return compileMatrix(model, view, ctx, true);
  // One column per period while that fits; one row per member and period when the statement would be too long.
  try {
    return compileGrouped(model, view, ctx);
  } catch (tooLong) {
    if (!(tooLong instanceof ReportingError) || tooLong.reason !== 'sql_too_long') throw tooLong;
    try {
      return compileMatrix(model, view, ctx, true);
    } catch (err) {
      // The long shape cannot take this view either, so the first refusal is the one to report.
      if (err instanceof ReportingError) throw tooLong;
      throw err;
    }
  }
}

/**
 * The same view answered from rollup tables, which is what a browser holds, or `no_rollup` when a
 * stream the view reads has no rollup with every dimension and measure the view needs.
 *
 * A rollup holds whole months, so each window and period of the view must start and end on the first
 * of a month. A transaction list and a snapshot measure are never answered from a rollup. Of the
 * rollups that can answer, the one with the fewest dimensions is read, then the first listed.
 * The statement still joins the dimension tables, so the caller needs those beside the rollup.
 */
export function compileRollupView(model: ReportingModel, view: ViewState, ctx: CompileContext): CompiledView | Refusal {
  // A view that does not compile at all refuses with its own reason, not for want of a rollup.
  const plain = compileView(model, view, ctx);
  if (!plain.ok) return plain;
  const none = (detail: string): Refusal => ({ ok: false, reason: 'no_rollup', detail });
  if (view.mode === 'transaction') return none('a transaction list reads the rows themselves');
  const windows: PeriodWindow[] = [plain.window, ...(plain.comparison ? [plain.comparison] : []), ...plain.buckets];
  if (!windows.every((w) => w.from.endsWith('-01') && w.to.endsWith('-01'))) {
    return none('a rollup holds whole months, and this period does not start and end on the first of a month');
  }
  let rolled = model;
  const rollups: CompiledRollup[] = [];
  for (const key of plain.streams ?? [view.stream]) {
    const listed = model.streams.find((s) => s.key === key)?.rollups ?? [];
    const smallestFirst = [...listed].sort((a, b) => Object.keys(a.dimension_keys).length - Object.keys(b.dimension_keys).length);
    // Each stream is grouped on its own, so a rollup that answers with the other streams left as they are answers with them rolled too.
    const pick = smallestFirst.find((rollup) => compileView(onRollup(model, key, rollup), view, ctx).ok);
    if (!pick) return none(`no rollup of "${key}" holds every dimension and measure this view reads`);
    rolled = onRollup(rolled, key, pick);
    rollups.push({ stream: key, rollup: pick.key, table: pick.table });
  }
  const out = compileView(rolled, view, ctx);
  return out.ok ? { ...out, rollups } : out;
}

/**
 * The model with one stream read from a rollup of it: the rollup's table and month column, the
 * dimensions it keeps, and the measures it carries. A measure it does not carry is left out, so a
 * view that reads one refuses.
 */
function onRollup(model: ReportingModel, streamKey: string, rollup: ModelRollup): ReportingModel {
  const carried = new Map(Object.entries(rollup.measure_columns));
  return {
    ...model,
    streams: model.streams.map((s) => (s.key !== streamKey ? s
      : { ...s, table: rollup.table, date: rollup.date, dimension_keys: rollup.dimension_keys, columns: [], rollups: [] })),
    measures: model.measures.flatMap((m): ModelMeasure[] => {
      if (isFormulaMeasure(m) || m.stream !== streamKey) return [m];
      const column = carried.get(m.key);
      return column === undefined ? [] : [{ ...m, column, rolled: true }];
    }),
  };
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
  /**
   * The focus: the drill steps on the group-by dimension itself. Only filled when asked for,
   * and then those steps are left out of `where`, so the members they leave out can still be read.
   */
  focus: string[];
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

function scopeOf(model: ReportingModel, view: ViewState, withMembers = false, splitFocus = false): Scope {
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
  const focus: string[] = [];
  const inList = (values: string[]): string => `(${values.map(sqlString).join(', ')})`;
  (view.path ?? []).forEach((step) => {
    const values = stringList(step?.selected, `the drill step on "${String(step?.dimension)}"`);
    const kept = `CAST(${codeOf(step.dimension)} AS VARCHAR) IN ${inList(values)}`;
    (splitFocus && step.dimension === groupDim.key ? focus : where).push(kept);
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
  return { stream, measureByKey, joins, dimension, propertyOf, groupDim, codeExpr, where, having, filterMeasures, members, focus };
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

/** A base measure's aggregate over the fact rows. `countAll` counts rows for a count with no column. */
function aggregateOf(measure: ModelBaseMeasure, countAll: string): string {
  const column = measure.column === undefined ? '' : `${FACT}.${q(measure.column)}`;
  // Read from a rollup, a count's column already holds the count for each row, so those are added up.
  return measure.agg === 'count' ? (measure.rolled ? `SUM(${column})` : column !== '' ? `COUNT(${column})` : countAll)
    : measure.agg === 'count_distinct' ? `COUNT(DISTINCT ${column})`
      : `${measure.agg.toUpperCase()}(${column})`;
}

/** The result column a grouped view's sort key names, or '' when it names none. */
function sortNameOf(by: unknown): string {
  const parts = String(by).split('.');
  const two = parts.length === 2;
  return parts[0] === 'code' && parts.length === 1 ? 'code'
    : parts[0] === 'property' && two ? `prop__${parts[1]}`
      : parts[0] === 'total' && two ? `m__${parts[1]}`
        : parts[0] === 'previous' && two ? `prev__${parts[1]}`
          : parts[0] === 'variance' && two ? `var__${parts[1]}`
            : parts[0] === 'variance_pct' && two ? `varp__${parts[1]}`
              : parts[0] === 'average' && two ? `avg__${parts[1]}`
                : parts[0] === 'period' && parts.length === 3 ? `b${parts[1]}__${parts[2]}`
                  : '';
}

/**
 * The condition a grouped row must pass: the view's filter on measures and, with `hide_zero_rows`,
 * at least one of `figures` that is not zero. A blank counts as zero.
 */
function keepRows(having: string | null, options: ViewOptions, figures: string[]): string | null {
  if (options.hide_zero_rows !== true || figures.length === 0) return having;
  const some = `(${figures.map((name) => `COALESCE(${q(name)}, 0) <> 0`).join(' OR ')})`;
  return having === null ? some : `(${some} AND ${having})`;
}

/**
 * How every grouped statement ends: stage r ranks and counts the rows of `source`, then one page is read.
 * A measure filter drops rows here, after grouping, and never drops the total row.
 * `extra.others`: g also holds an others row (`__total` 2). `extra.average` and `extra.sum`: the measure
 * columns an average row (`__total` 3) and a sum row (`__total` 4) are worked out for, over every row
 * the list holds, on any page.
 */
function rankAndPage(
  source: string, sortName: string, sort: ViewSort, having: string | null, left: string[], offset: number, limit: number,
  extra: { others: boolean; average: string[]; sum: string[] } = { others: false, average: [], sum: [] },
): string[] {
  const summary = extra.others ? '"__total" > 0' : '"__total" = 1';
  const page = `WHERE ${summary} OR ("__rn" > ${offset} AND "__rn" <= ${offset + limit})`;
  const hide = `SELECT * EXCLUDE (${left.map(q).join(', ')}) FROM`;
  // One stage a summary row: one function over each measure column of the member rows r holds.
  const over = (stage: string, fn: 'avg' | 'sum', mark: number, names: string[]): string[] => (names.length === 0 ? [] : [
    `), ${stage} AS (`,
    `SELECT ${names.map((name) => `${fn}(${q(name)}) AS ${q(name)}`).join(', ')}, ${mark} AS "__total", 0 AS "__rn", CAST(count(*) AS INTEGER) AS "__rows"`,
    'FROM r',
    'WHERE "__total" = 0',
  ]);
  const stages = [...over('a', 'avg', 3, extra.average), ...over('sm', 'sum', 4, extra.sum)];
  return [
    '), r AS (',
    `SELECT ${source}.*, row_number() OVER (PARTITION BY "__total" ORDER BY ${q(sortName)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, "code" ASC) AS "__rn",`,
    'CAST(sum(CASE WHEN "__total" = 0 THEN 1 ELSE 0 END) OVER () AS INTEGER) AS "__rows"',
    `FROM ${source}`,
    ...(having !== null ? [`WHERE ${summary} OR ${having}`] : []),
    ...(stages.length === 0 ? [')', `${hide} r`, page] : [
      ...stages,
      ')',
      `${hide} (`,
      'SELECT * FROM r',
      page,
      // A summary row has no code and no property, so the columns are matched by name.
      ...(extra.average.length > 0 ? ['UNION ALL BY NAME', 'SELECT * FROM a'] : []),
      ...(extra.sum.length > 0 ? ['UNION ALL BY NAME', 'SELECT * FROM sm'] : []),
      ') AS p',
    ]),
    'ORDER BY "__total" DESC, "__rn" ASC',
  ];
}

/**
 * One window of dates a measure is computed over: the condition that picks its
 * fact rows, and the one that picks the rows of its latest day (for a snapshot measure).
 */
interface Slice { bucket: PeriodBucket; filter: string; last: string }

/** What a measure of one stream is computed from. */
interface MeasureSource {
  stream: ModelStream;
  measureByKey: Map<string, ModelMeasure>;
  parsed: Map<string, FormulaNode>;
  /** How a count with no column counts the fact rows. */
  countAll: string;
  /** Days in the whole window, for a measure not cut to a slice. */
  days: number;
  /** The number of period columns, in a period view. */
  periodCount?: number;
  /**
   * The long shape only: true on a result row that is one period's cell, false on a total over the whole window.
   * A snapshot measure reads a different latest day on each.
   */
  cellWhen?: string;
  /** The long shape only: SQL for the days a result row covers. */
  daysSql?: string;
  /** Gains 'snapshot' when a snapshot measure is read, so the fact rows get their latest-day flags. */
  uses: Set<'snapshot'>;
}

/** One measure over a slice, or over the whole window: an aggregate for a base measure, the formula over those aggregates otherwise. */
function measureOver(src: MeasureSource, key: string, slice: Slice | null, depth = 0): string {
  if (depth > 20) fail('formula_cycle', `"${key}" refers back to itself`);
  const measure = src.measureByKey.get(key) ?? fail('formula_unknown_measure', `"${key}" is not a measure`);
  if (isFormulaMeasure(measure)) {
    let node = src.parsed.get(key);
    if (!node) { node = parseFormula(measure.formula); src.parsed.set(key, node); }
    return emitFormulaSql(node, {
      measure: (ref) => measureOver(src, ref, slice, depth + 1),
      ...(slice ? { days: slice.bucket.days } : src.daysSql !== undefined ? { daysSql: src.daysSql } : { days: src.days }),
      ...(src.periodCount !== undefined ? { periodCount: src.periodCount } : {}),
    });
  }
  if (measure.stream !== src.stream.key) fail('measure_not_on_stream', `"${key}" belongs to stream "${measure.stream}", not "${src.stream.key}"`);
  const call = aggregateOf(measure, src.countAll);
  // A level, not a flow: only the rows of the window's latest day count.
  if (measure.snapshot) {
    src.uses.add('snapshot');
    if (slice) return `${call} FILTER (WHERE ${slice.last})`;
    const whole = `${call} FILTER (WHERE ${FACT}."__lastw")`;
    return src.cellWhen !== undefined ? `CASE WHEN ${src.cellWhen} THEN ${call} FILTER (WHERE ${FACT}."__last") ELSE ${whole} END` : whole;
  }
  const over = slice ? `${call} FILTER (WHERE ${slice.filter})` : call;
  // A count of no rows is 0, where a sum of no rows is blank; a count read from a rollup stays a count.
  return measure.agg === 'count' && measure.rolled ? `COALESCE(${over}, 0)` : over;
}

/** A stream's fact rows in one window, aliased f. With `latest`, each row is flagged when it is on the window's latest day. */
function factOver(stream: ModelStream, range: PeriodWindow, latest: boolean): string {
  const date = q(stream.date);
  const rows = `SELECT * FROM ${q(stream.table)} WHERE ${date} >= ${sqlDate(range.from)} AND ${date} < ${sqlDate(range.to)}`;
  return latest ? `(SELECT *, (${date} = MAX(${date}) OVER ()) AS "__lastw" FROM (${rows}) AS s) AS ${FACT}` : `(${rows}) AS ${FACT}`;
}

/** A CASE over a fact row's date that gives the rows of each period column their own value. */
function perBucket(date: string, buckets: PeriodBucket[], value: (bucket: PeriodBucket, index: number) => number): string {
  return `CASE ${buckets.map((b, i) => `WHEN ${date} < ${sqlDate(b.to)} THEN ${value(b, i)}`).join(' ')} END`;
}

/** The properties a view shows beside the code, each once. */
function shownProperties(view: ViewState): string[] {
  return (view.properties ?? []).filter((property, i, all) => property !== 'code' && all.indexOf(property) === i);
}

function propertyLabel(dim: ModelDimension, property: string): string {
  return property === 'name' ? 'Name' : dim.properties.find((p) => p.key === property)?.label ?? property;
}

/** Total, period and variance modes: one row per member of the group-by dimension. */
function compileGrouped(model: ReportingModel, view: ViewState, ctx: CompileContext): Compiled {
  const options: ViewOptions = view.options ?? {};
  const activity = options.activity ?? 'with';
  if (activity !== 'with' && activity !== 'without' && activity !== 'all') fail('option_unsupported', `"${String(activity)}" is not an activity option`);
  if (options.others_row && activity !== 'with') fail('option_unsupported', 'an others row with the activity option is not compiled yet');
  // Members with no activity have no figures, so a list of them has no total row.
  const totalRow = options.total_row === true && activity !== 'without';
  const averageRow = options.average_row === true;
  const sumRow = options.sum_row === true;
  // A member with no activity has blank figures, which this option would hide again.
  if (options.hide_zero_rows && activity !== 'with') fail('option_unsupported', 'hiding zero rows with the activity option is not compiled yet');
  const averageColumn = options.average_column === true && view.mode === 'period';

  const scope = scopeOf(model, view, activity !== 'with', options.others_row === true);
  const { stream, measureByKey, joins, groupDim, where, members } = scope;
  // The others row is the members the focus leaves out, so it exists only when the view focuses on some.
  // A member with no code is never one the focus picked.
  const focused = scope.focus.length > 0 ? `COALESCE(${scope.focus.join(' AND ')}, FALSE)` : null;
  const othersRow = focused !== null;
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
    : `, ${perBucket(date, buckets, (_, i) => i + 1)} AS "__b"`;
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
  const reads: MeasureSource = {
    stream,
    measureByKey,
    parsed: new Map(),
    // A member with no fact rows still has one row in the join, which a bare COUNT(*) would count.
    countAll: members ? `COUNT(${FACT}."__in")` : 'COUNT(*)',
    days: windowDays,
    ...(view.mode === 'period' ? { periodCount: buckets.length } : {}),
    uses,
  };
  const measureSql = (key: string, slice: Slice | null): string => measureOver(reads, key, slice);

  // The select list and the column map, in display order.
  const columns: CompiledColumn[] = [{ name: 'code', kind: 'code', label: groupDim.label }];
  const select: string[] = [`${codeExpr} AS "code"`];
  const grouping = `GROUPING(${codeExpr})`;
  (view.properties ?? []).forEach((property, i) => {
    if (property === 'code') return;
    if ((view.properties ?? []).indexOf(property) !== i) return;
    const expr = `any_value(${members ? members.property(property) : scope.propertyOf(groupDim.key, property)})`;
    const name = `prop__${property}`;
    select.push(`${totalRow || othersRow ? `CASE WHEN ${grouping} = 0 THEN ${expr} END` : expr} AS ${q(name)}`);
    const label = propertyLabel(groupDim, property);
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
        put(select, `b${index}__${measure.key}`, double(measureSql(measure.key, slice)), true,
          { ...about, label: `${measure.label} ${slice.bucket.label}`, period: slice.bucket });
      });
    }
    const wholeName = `m__${measure.key}`;
    put(select, wholeName, double(measureSql(measure.key, current)), seen, {
      ...about,
      label: view.mode === 'period' ? `${measure.label} Total` : measure.label,
      period: current ? current.bucket : null,
      ...(current ? { part: 'current' as const } : {}),
    });
    if (seen && averageColumn) {
      // Worked out in stage v from the row's own period columns, so it holds on the total row too.
      put(derived, `avg__${measure.key}`, `list_avg([${slices.map((_, i) => q(`b${i + 1}__${measure.key}`)).join(', ')}])`, true,
        { ...about, label: `${measure.label} Average`, period: null, average: true });
    }
    if (!current || !previous) return;
    const cur = q(wholeName);
    const prev = q(`prev__${measure.key}`);
    put(select, `prev__${measure.key}`, double(measureSql(measure.key, previous)), seen,
      { ...about, label: `${measure.label} ${previous.bucket.label}`, period: previous.bucket, part: 'previous' });
    // A member with nothing in one window still has a variance: the blank counts as 0.
    put(derived, `var__${measure.key}`, `COALESCE(${cur}, 0) - COALESCE(${prev}, 0)`, seen,
      { ...about, label: `${measure.label} Variance`, period: null, part: 'variance' });
    put(derived, `varp__${measure.key}`, `(COALESCE(${cur}, 0) - ${prev}) / NULLIF(abs(${prev}), 0)`, seen,
      { measure: measure.key, format: 'percent', label: `${measure.label} Variance %`, period: null, part: 'variance_pct' });
  };
  shown.forEach((measure) => addMeasure(measure, true));
  unseen.forEach((measure) => addMeasure(measure, false));
  if (focused !== null) {
    // Grouped by the flag too: the total is then the focused members' and the others row the rest's.
    select.push(`${focused} AS "__f"`, `CASE WHEN ${grouping} = 0 THEN 0 WHEN "__f" THEN 1 ELSE 2 END AS "__total"`);
    left.push('__f');
  } else {
    select.push(`${totalRow ? `CAST(${grouping} AS INTEGER)` : '0'} AS "__total"`);
  }
  columns.push({ name: '__total', kind: 'meta', label: 'Total row' }, { name: '__rows', kind: 'meta', label: 'Row count' });

  // Sort and paging.
  const sort: ViewSort = view.sort ?? { by: `total.${shown[0]?.key ?? ''}`, dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  const sortName = sortNameOf(sort.by);
  if (!columns.some((c) => c.name === sortName && c.kind !== 'meta')) fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  const { limit, offset } = pageOf(view, ctx, (totalRow ? 1 : 0) + (othersRow ? 1 : 0) + (averageRow ? 1 : 0) + (sumRow ? 1 : 0));
  const measured = columns.filter((c) => c.kind === 'measure').map((c) => c.name);
  // What "zero" is judged on: each shown measure over the whole period, and over the earlier one in a variance.
  const figures = shown.flatMap((m) => (previous ? [`m__${m.key}`, `prev__${m.key}`] : [`m__${m.key}`]));

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

  // The total row stays the total of every member, whatever a measure filter drops.
  const source = derived.length > 0 ? 'v' : 'g';
  const sql = [
    'WITH g AS (',
    `SELECT ${select.join(', ')}`,
    ...from,
    ...(othersRow ? [
      `GROUP BY GROUPING SETS ((${codeExpr}, "__f"), ("__f"))`,
      // Keeps the focused members and the others row, and the focused members' total when it is shown.
      totalRow ? `HAVING ${grouping} = 1 OR "__f"` : `HAVING "__f" = (${grouping} = 0)`,
    ] : [totalRow ? `GROUP BY GROUPING SETS ((${codeExpr}), ())` : `GROUP BY ${codeExpr}`]),
    ...(activity === 'without' ? [`HAVING COUNT(${FACT}."__in") = 0`] : []),
    ...(source === 'v' ? ['), v AS (', `SELECT g.*, ${derived.join(', ')}`, 'FROM g'] : []),
    ...rankAndPage(source, sortName, sort, keepRows(scope.having, options, figures), left, offset, limit,
      { others: othersRow, average: averageRow ? measured : [], sum: sumRow ? measured : [] }),
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
function compileTransactions(model: ReportingModel, view: ViewState, ctx: CompileContext): Compiled {
  const options: ViewOptions = view.options ?? {};
  if (options.activity !== undefined && options.activity !== 'with') fail('option_unsupported', 'a transaction list shows rows that exist; activity does not apply');
  if (options.total_row || options.others_row || options.average_row || options.sum_row) fail('option_unsupported', 'a transaction list has no total, others, average or sum row');

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

/**
 * Stream mode: measures from more than one stream, side by side, over the whole period.
 *
 * Each stream is grouped on its own (stages s1, s2, ...) under the same drill path, filters and keyword,
 * so no fact row of one stream is ever joined to a fact row of another. Stage g stacks those results,
 * folds them to one row per member, and works the formulas out from the folded sums.
 */
function compileStreams(model: ReportingModel, view: ViewState, ctx: CompileContext): Compiled {
  const options: ViewOptions = view.options ?? {};
  if ((options.activity ?? 'with') !== 'with') fail('option_unsupported', 'the activity option is not compiled for stream mode yet');
  if (options.others_row) fail('option_unsupported', 'an others row is not compiled for stream mode yet');
  const totalRow = options.total_row === true;
  const averageRow = options.average_row === true;
  const sumRow = options.sum_row === true;

  // The view's own stream is always read. It also settles the measure filters, which are the same for every stream.
  const lead = scopeOf(model, view);
  const { measureByKey, groupDim } = lead;
  const shown = shownMeasures(view, measureByKey);
  const unseen = lead.filterMeasures
    .filter((key) => !view.measures.includes(key))
    .map((key) => measureByKey.get(key) ?? fail('unknown_measure', `no measure "${key}"`));
  const period = resolvePeriod(view.period, model.periods, ctx.today, { periodToDate: options.period_to_date === true });
  const range = period.window;

  // Each measure as an expression over the folded sums; `needed` collects the sums each stream must supply.
  const needed = new Map<string, ModelBaseMeasure[]>();
  const parsed = new Map<string, FormulaNode>();
  const exprOf = (key: string, depth: number): string => {
    if (depth > 20) fail('formula_cycle', `"${key}" refers back to itself`);
    const measure = measureByKey.get(key) ?? fail('formula_unknown_measure', `"${key}" is not a measure`);
    if (isFormulaMeasure(measure)) {
      let node = parsed.get(key);
      if (!node) { node = parseFormula(measure.formula); parsed.set(key, node); }
      return emitFormulaSql(node, { measure: (ref) => exprOf(ref, depth + 1), days: daysBetween(range.from, range.to) });
    }
    const list = needed.get(measure.stream) ?? [];
    if (!list.some((m) => m.key === measure.key)) list.push(measure);
    needed.set(measure.stream, list);
    return `any_value(${q(`a__${measure.key}`)})`;
  };

  const properties = shownProperties(view);
  const columns: CompiledColumn[] = [{ name: 'code', kind: 'code', label: groupDim.label }];
  const select: string[] = ['"code"'];
  properties.forEach((property) => {
    const name = `prop__${property}`;
    select.push(`any_value(${q(name)}) AS ${q(name)}`);
    const label = propertyLabel(groupDim, property);
    columns.push({ name, kind: 'property', label, property });
  });
  const left: string[] = ['__rn'];
  const addMeasure = (measure: ModelMeasure, seen: boolean): void => {
    const name = `m__${measure.key}`;
    select.push(`CAST(${exprOf(measure.key, 0)} AS DOUBLE) AS ${q(name)}`);
    if (seen) columns.push({ name, kind: 'measure', label: measure.label, measure: measure.key, format: measure.format, period: null });
    else left.push(name);
  };
  shown.forEach((measure) => addMeasure(measure, true));
  unseen.forEach((measure) => addMeasure(measure, false));
  select.push('"__total"');
  columns.push({ name: '__total', kind: 'meta', label: 'Total row' }, { name: '__rows', kind: 'meta', label: 'Row count' });

  const sort: ViewSort = view.sort ?? { by: `total.${shown[0]?.key ?? ''}`, dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  const sortName = sortNameOf(sort.by);
  if (!columns.some((c) => c.name === sortName && c.kind !== 'meta')) fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  const { limit, offset } = pageOf(view, ctx, (totalRow ? 1 : 0) + (averageRow ? 1 : 0) + (sumRow ? 1 : 0));
  const measured = columns.filter((c) => c.kind === 'measure').map((c) => c.name);

  // One stage per stream: the view's own first, then the others its measures read, in the model's order.
  const streamKeys = [lead.stream.key, ...model.streams.map((s) => s.key).filter((key) => key !== lead.stream.key && needed.has(key))];
  const stages = streamKeys.flatMap((key, i) => {
    // A stream that lacks a dimension the view uses refuses here, by name.
    const scope = i === 0 ? lead : scopeOf(model, { ...view, stream: key });
    const { stream, codeExpr } = scope;
    const mine = needed.get(key) ?? [];
    const grouping = `GROUPING(${codeExpr})`;
    const part: string[] = [`${codeExpr} AS "code"`];
    properties.forEach((property) => {
      const expr = `any_value(${scope.propertyOf(groupDim.key, property)})`;
      part.push(`${totalRow ? `CASE WHEN ${grouping} = 0 THEN ${expr} END` : expr} AS ${q(`prop__${property}`)}`);
    });
    mine.forEach((measure) => {
      const call = aggregateOf(measure, 'COUNT(*)');
      part.push(`${measure.snapshot ? `${call} FILTER (WHERE ${FACT}."__lastw")` : call} AS ${q(`a__${measure.key}`)}`);
    });
    part.push(`${totalRow ? `CAST(${grouping} AS INTEGER)` : '0'} AS "__total"`);
    return [
      `${i === 0 ? 'WITH' : '),'} s${i + 1} AS (`,
      `SELECT ${part.join(', ')}`,
      // A snapshot measure reads its own stream's latest day in the period.
      `FROM ${factOver(stream, range, mine.some((measure) => measure.snapshot))}`,
      ...scope.joins.values(),
      ...(scope.where.length > 0 ? [`WHERE ${scope.where.join(' AND ')}`] : []),
      totalRow ? `GROUP BY GROUPING SETS ((${codeExpr}), ())` : `GROUP BY ${codeExpr}`,
    ];
  });

  const sql = [
    ...stages,
    '), g AS (',
    `SELECT ${select.join(', ')}`,
    // By name: each stage has its own sum columns, and a member one stream lacks gets blanks there.
    `FROM (${streamKeys.map((_, i) => `SELECT * FROM s${i + 1}`).join(' UNION ALL BY NAME ')}) AS u`,
    'GROUP BY "code", "__total"',
    ...rankAndPage('g', sortName, sort, keepRows(lead.having, options, shown.map((m) => `m__${m.key}`)), left, offset, limit,
      { others: false, average: averageRow ? measured : [], sum: sumRow ? measured : [] }),
  ].join('\n');
  checkLength(sql, ctx);

  return { ok: true, sql, columns, window: range, buckets: [], months: monthsRange(range), streams: streamKeys };
}

/**
 * Matrix mode, and the long shape of a period view: two axes, one result row per cell.
 *
 * The rows are the group-by dimension. The columns are a second dimension (matrix) or the view's
 * periods (the long shape, for a period view whose one-column-per-period statement is too long).
 *
 * Stage g groups four ways in one pass: each cell, each row's total, each column's total and the grand
 * total, so a formula is worked out at every level from that level's own sums. Stage rw ranks the rows
 * by their totals, stage cl numbers the columns, and the result keeps the cells of one page of rows and
 * the columns kept. The grid pivots it: `__row` and `__col` say where a cell goes, 0 meaning a total.
 */
function compileMatrix(model: ReportingModel, view: ViewState, ctx: CompileContext, byPeriod = false): Compiled {
  const options: ViewOptions = view.options ?? {};
  const what = byPeriod ? 'the long shape of a period view' : 'matrix mode';
  if (byPeriod && options.average_column) fail('option_unsupported', 'the average column is not compiled for the long shape of a period view yet');
  if ((options.activity ?? 'with') !== 'with') fail('option_unsupported', `the activity option is not compiled for ${what} yet`);
  if (options.others_row || options.average_row || options.sum_row) fail('option_unsupported', `others, average and sum rows are not compiled for ${what} yet`);
  const totalRow = options.total_row === true;

  const scope = scopeOf(model, view);
  const { stream, measureByKey, groupDim } = scope;
  const shown = shownMeasures(view, measureByKey);
  const first = shown[0] ?? fail('no_measures', 'a view needs at least one measure');
  const unseen = scope.filterMeasures
    .filter((key) => !view.measures.includes(key))
    .map((key) => measureByKey.get(key) ?? fail('unknown_measure', `no measure "${key}"`));
  const period = resolvePeriod(view.period, model.periods, ctx.today, { periodToDate: options.period_to_date === true });
  const range = period.window;
  const buckets = byPeriod ? period.buckets : [];
  const days = daysBetween(range.from, range.to);

  // The column axis: what a fact row's column is, how many are kept, and how they are numbered.
  const uses = new Set<'snapshot'>();
  const reads: MeasureSource = { stream, measureByKey, parsed: new Map(), countAll: 'COUNT(*)', days, uses };
  const rowCode = scope.codeExpr;
  let colCode = `${FACT}."__b"`;
  let keep = buckets.length;
  let acrossColumn: CompiledColumn = { name: 'across', kind: 'across', label: 'Period' };
  let acrossName: CompiledColumn | null = null;
  // A period's column number is its own number, so a period no fact row falls in leaves a gap, not a shift.
  let colNumber = options.reverse_periods ? `${buckets.length + 1} - "across"` : '"across"';
  let colCount = String(buckets.length);
  if (byPeriod) {
    reads.periodCount = buckets.length;
    // A row of g is one period's cell or a total over the whole window; days and latest days differ between them.
    reads.cellWhen = `GROUPING(${colCode}) = 0`;
    reads.daysSql = `CASE WHEN GROUPING(${colCode}) = 0 THEN any_value(${FACT}."__days") ELSE ${sqlNumber(days)} END`;
  } else {
    const across = view.across;
    if (!across || typeof across.dimension !== 'string') fail('bad_across', 'a matrix needs a second dimension in "across"');
    const acrossDim = scope.dimension(across.dimension);
    if (acrossDim.key === groupDim.key) fail('bad_across', 'the second dimension must differ from the first');
    const order = across.order ?? 'value';
    if (order !== 'value' && order !== 'code') fail('bad_across', `"${String(order)}" is not a column order`);
    keep = across.limit ?? DEFAULT_ACROSS_MEMBERS;
    if (!Number.isInteger(keep) || keep < 1) fail('bad_across', 'across.limit must be a whole number, 1 or more');
    colCode = scope.propertyOf(acrossDim.key, 'code');
    acrossColumn = { name: 'across', kind: 'across', label: acrossDim.label, dimension: acrossDim.key };
    if (acrossDim.table && acrossDim.name) {
      acrossName = { name: 'across__name', kind: 'across', label: propertyLabel(acrossDim, 'name'), dimension: acrossDim.key, property: 'name' };
    }
    colNumber = `row_number() OVER (ORDER BY ${order === 'value' ? `${q(`m__${first.key}`)} DESC NULLS LAST, ` : ''}"across" ASC)`;
    colCount = 'CAST((SELECT count(*) FROM cl) AS INTEGER)';
  }

  // Paging. Every row kept costs one result row per column kept, plus one for its total, so a page is fitted to the row cap.
  // A matrix always returns its column totals, which name its columns; a period view needs them only for the total row.
  const maxRows = ctx.maxRows ?? ROUTE_MAX_ROWS;
  const columnTotals = totalRow || !byPeriod;
  const reserved = (columnTotals ? keep : 0) + (totalRow ? 1 : 0);
  const room = Math.floor((maxRows - reserved) / (keep + 1));
  if (room < 1) fail('bad_paging', `${keep} columns leave no room for a row in ${maxRows} result rows`);
  const asked = view.limit ?? DEFAULT_PAGE_ROWS;
  const offset = view.offset ?? 0;
  if (!Number.isInteger(asked) || asked < 1) fail('bad_paging', 'limit must be a whole number, 1 or more');
  if (!Number.isInteger(offset) || offset < 0) fail('bad_paging', 'offset must be a whole number, 0 or more');
  const limit = Math.min(asked, room);

  // The select list and the column map.
  const columns: CompiledColumn[] = [{ name: 'code', kind: 'code', label: groupDim.label }];
  const select: string[] = [`${rowCode} AS "code"`];
  shownProperties(view).forEach((property) => {
    const name = `prop__${property}`;
    select.push(`CASE WHEN GROUPING(${rowCode}) = 0 THEN any_value(${scope.propertyOf(groupDim.key, property)}) END AS ${q(name)}`);
    columns.push({ name, kind: 'property', label: propertyLabel(groupDim, property), property });
  });
  select.push(`${colCode} AS "across"`);
  columns.push(acrossColumn);
  if (acrossName && acrossColumn.dimension !== undefined) {
    select.push(`CASE WHEN GROUPING(${colCode}) = 0 THEN any_value(${scope.propertyOf(acrossColumn.dimension, 'name')}) END AS "across__name"`);
    columns.push(acrossName);
  }
  const hidden: string[] = [];
  const addMeasure = (measure: ModelMeasure, seen: boolean): void => {
    const name = `m__${measure.key}`;
    select.push(`CAST(${measureOver(reads, measure.key, null)} AS DOUBLE) AS ${q(name)}`);
    if (seen) columns.push({ name, kind: 'measure', label: measure.label, measure: measure.key, format: measure.format, period: null });
    else hidden.push(name);
  };
  shown.forEach((measure) => addMeasure(measure, true));
  unseen.forEach((measure) => addMeasure(measure, false));

  // Sort. Rows are ranked by their totals; the long shape can also rank them by one period of one measure.
  const sort: ViewSort = view.sort ?? { by: `total.${first.key}`, dir: 'desc' };
  if (sort.dir !== 'asc' && sort.dir !== 'desc') fail('bad_sort', 'sort.dir must be asc or desc');
  let sortName = sortNameOf(sort.by);
  const byOne = String(sort.by).split('.');
  const bucket = byPeriod && byOne[0] === 'period' && byOne.length === 3 ? buckets[Number(byOne[1]) - 1] : undefined;
  if (bucket && shown.some((measure) => measure.key === byOne[2])) {
    const n = buckets.indexOf(bucket) + 1;
    const slice: Slice = { bucket, filter: `${FACT}."__b" = ${n}`, last: `${FACT}."__b" = ${n} AND ${FACT}."__last"` };
    select.push(`CAST(${measureOver(reads, String(byOne[2]), slice)} AS DOUBLE) AS "__sort"`);
    hidden.push('__sort');
    sortName = '__sort';
  } else if (!columns.some((c) => c.name === sortName && c.kind !== 'across')) {
    fail('bad_sort', `"${String(sort.by)}" is not a column of this view`);
  }
  select.push(`CAST(GROUPING(${rowCode}) AS INTEGER) AS "__total"`, `CAST(GROUPING(${colCode}) AS INTEGER) AS "__across_total"`);
  columns.push(
    { name: '__total', kind: 'meta', label: 'Total row' },
    { name: '__across_total', kind: 'meta', label: 'Row total' },
    { name: '__row', kind: 'meta', label: 'Row number' },
    { name: '__col', kind: 'meta', label: 'Column number' },
    { name: '__rows', kind: 'meta', label: 'Row count' },
    { name: '__cols', kind: 'meta', label: 'Column count' },
  );

  // The fact rows. By period, each carries its period's number, and what a formula or a snapshot measure needs of it.
  let fact = factOver(stream, range, uses.has('snapshot'));
  if (byPeriod) {
    const date = q(stream.date);
    const perDay = select.some((expr) => expr.includes('"__days"')) ? `, ${perBucket(date, buckets, (b) => b.days)} AS "__days"` : '';
    const rows = `SELECT *, ${perBucket(date, buckets, (_, i) => i + 1)} AS "__b"${perDay} FROM ${q(stream.table)} WHERE ${date} >= ${sqlDate(range.from)} AND ${date} < ${sqlDate(range.to)}`;
    const latest = `(${date} = MAX(${date}) OVER (PARTITION BY "__b")) AS "__last", (${date} = MAX(${date}) OVER ()) AS "__lastw"`;
    fact = uses.has('snapshot') ? `(SELECT *, ${latest} FROM (${rows}) AS s) AS ${FACT}` : `(${rows}) AS ${FACT}`;
  }

  const paged = `rw."__row" > ${offset} AND rw."__row" <= ${offset + limit}`;
  // The rows returned beside the page: the whole total row, or just the column totals, or none.
  const beside = totalRow ? 'g."__total" = 1' : columnTotals ? '(g."__total" = 1 AND g."__across_total" = 0)' : null;
  const kept = keepRows(scope.having, options, shown.map((m) => `m__${m.key}`));
  const sql = [
    // Read three times below, so it is computed once.
    'WITH g AS MATERIALIZED (',
    `SELECT ${select.join(', ')}`,
    `FROM ${fact}`,
    ...scope.joins.values(),
    ...(scope.where.length > 0 ? [`WHERE ${scope.where.join(' AND ')}`] : []),
    `GROUP BY GROUPING SETS ((${rowCode}, ${colCode}), (${rowCode}), (${colCode}), ())`,
    // Rows are ranked, and filtered on a measure, by their totals across every column.
    '), rw AS (',
    `SELECT "code", row_number() OVER (ORDER BY ${q(sortName)} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, "code" ASC) AS "__row"`,
    'FROM g',
    `WHERE "__total" = 0 AND "__across_total" = 1${kept !== null ? ` AND ${kept}` : ''}`,
    '), cl AS (',
    `SELECT "across", ${colNumber} AS "__col"`,
    'FROM g',
    'WHERE "__total" = 1 AND "__across_total" = 0',
    ')',
    `SELECT g.*${hidden.length > 0 ? ` EXCLUDE (${hidden.map(q).join(', ')})` : ''}, COALESCE(rw."__row", 0) AS "__row", COALESCE(cl."__col", 0) AS "__col",`,
    `CAST((SELECT count(*) FROM rw) AS INTEGER) AS "__rows", ${colCount} AS "__cols"`,
    'FROM g',
    // A member can have no code, so the joins match a blank to a blank.
    'LEFT JOIN rw ON g."__total" = 0 AND rw."code" IS NOT DISTINCT FROM g."code"',
    'LEFT JOIN cl ON g."__across_total" = 0 AND cl."across" IS NOT DISTINCT FROM g."across"',
    `WHERE ${beside !== null ? `(${beside} OR (${paged}))` : paged} AND (g."__across_total" = 1 OR cl."__col" <= ${keep})`,
    'ORDER BY g."__total" DESC, rw."__row" ASC, g."__across_total" DESC, cl."__col" ASC',
  ].join('\n');
  checkLength(sql, ctx);

  return {
    ok: true,
    sql,
    columns,
    window: range,
    buckets,
    months: monthsRange(range),
    shape: 'long',
    ...(byPeriod && options.reverse_periods ? { reversed: true as const } : {}),
    limit,
    ...(acrossColumn.dimension !== undefined ? { across: { dimension: acrossColumn.dimension, limit: keep } } : {}),
  };
}

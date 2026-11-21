/**
 * The reporting model: what a tenant's tables mean in the words its people use.
 *
 * A model is data, written per install. Nothing here names a tenant, a source
 * system or a column of theirs. `validateModel` takes untrusted JSON and either
 * returns a model the compiler can rely on, or every problem it found.
 */
import { formulaRefs, parseFormula } from './formula';
import { isIsoDate, type NamedPeriod, type PeriodCalendar } from './periods';
import { ReportingError } from './reasons';
import { isIdentifier } from './sql';

export const MODEL_VERSION = 1;
export const MEASURE_AGGS = ['sum', 'count', 'count_distinct', 'min', 'max', 'avg'] as const;
export type MeasureAgg = (typeof MEASURE_AGGS)[number];
export const MEASURE_FORMATS = ['number', 'integer', 'currency', 'percent'] as const;
export type MeasureFormat = (typeof MEASURE_FORMATS)[number];

export interface ModelStream {
  key: string;
  label: string;
  /** The conformed fact table. */
  table: string;
  /** Its date column. */
  date: string;
  /** Dimension key to the fact column that holds that dimension's code. */
  dimension_keys: Record<string, string>;
  /** Other columns of the fact table a transaction list can show: a document number, a reference. */
  columns: ModelStreamColumn[];
  /** Tables that hold this stream already added up by month. A view one of them covers can be answered from it. */
  rollups: ModelRollup[];
}

/**
 * One rollup of a stream: its figures added up by month and by some of the stream's dimensions.
 * It is small enough to hand to a browser, where the fact table is not.
 */
export interface ModelRollup {
  key: string;
  table: string;
  /** Its date column: the first day of the month a row covers. */
  date: string;
  /** The stream's dimensions the rollup keeps: dimension key to the rollup column that holds the code. */
  dimension_keys: Record<string, string>;
  /**
   * The stream's measures the rollup carries: measure key to the rollup column that holds it for the row's
   * month. A sum or a count is added up again, a least or greatest value is taken again. A snapshot, a
   * distinct count and an average cannot be rebuilt from months, so a rollup never carries one.
   */
  measure_columns: Record<string, string>;
}

export interface ModelProperty { key: string; label: string; column: string }
export interface ModelStreamColumn { key: string; label: string; column: string }

export interface ModelDimension {
  key: string;
  label: string;
  /** Lookup table with one row per code. Without it the code is all there is. */
  table?: string;
  code?: string;
  name?: string;
  properties: ModelProperty[];
  /** This dimension is an attribute of another: that dimension's table holds this one's code in `column`. */
  via?: { dimension: string; column: string };
}

export interface ModelBaseMeasure {
  key: string;
  label: string;
  agg: MeasureAgg;
  /** Absent only for `count`. */
  column?: string;
  stream: string;
  format: MeasureFormat;
  /** A level, not a flow (stock on hand): the latest value in a period, never a sum over time. */
  snapshot: boolean;
  /** Set by the compiler when it reads a rollup, never read from a model: `column` already holds this count for each row. */
  rolled?: boolean;
}

export interface ModelFormulaMeasure {
  key: string;
  label: string;
  formula: string;
  format: MeasureFormat;
}

export type ModelMeasure = ModelBaseMeasure | ModelFormulaMeasure;

export interface ReportingModel {
  model_version: typeof MODEL_VERSION;
  streams: ModelStream[];
  dimensions: ModelDimension[];
  measures: ModelMeasure[];
  periods: PeriodCalendar;
}

export const MODEL_PROBLEMS = [
  'not_an_object', 'unsupported_model_version', 'no_streams', 'missing_field', 'bad_key', 'bad_identifier',
  'duplicate_key', 'unknown_stream', 'unknown_dimension', 'dimension_table_incomplete', 'via_parent_has_no_table',
  'dimension_cycle', 'measure_shape', 'unknown_agg', 'unknown_format', 'formula_invalid', 'formula_unknown_measure',
  'formula_cycle', 'bad_fiscal_month', 'bad_week_start', 'bad_date', 'period_range_inverted',
  'rollup_dimension_not_on_stream', 'rollup_measure_unknown', 'rollup_measure_not_additive',
] as const;
export type ModelProblemReason = (typeof MODEL_PROBLEMS)[number];

export interface ModelProblem { reason: ModelProblemReason; path: string; detail: string }
export type ModelValidation = { ok: true; model: ReportingModel } | { ok: false; problems: ModelProblem[] };

const KEY_RX = /^[a-z][a-z0-9_]{0,62}$/;

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** True when `record` has `k` as its own entry, so a key such as "constructor" finds nothing. */
function has(record: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, k);
}

export function isFormulaMeasure(m: ModelMeasure): m is ModelFormulaMeasure {
  return 'formula' in m;
}

export function validateModel(input: unknown): ModelValidation {
  const problems: ModelProblem[] = [];
  const bad = (reason: ModelProblemReason, path: string, detail: string): void => { problems.push({ reason, path, detail }); };

  if (!isRec(input)) return { ok: false, problems: [{ reason: 'not_an_object', path: '', detail: 'the model must be a JSON object' }] };
  if (input.model_version !== MODEL_VERSION) {
    return { ok: false, problems: [{ reason: 'unsupported_model_version', path: 'model_version', detail: `this package reads model_version ${MODEL_VERSION}` }] };
  }

  const key = (v: unknown, path: string): string | null => {
    if (typeof v === 'string' && KEY_RX.test(v)) return v;
    bad('bad_key', path, 'a key is lower case letters, digits and underscores, starting with a letter');
    return null;
  };
  const ident = (v: unknown, path: string): string | null => {
    if (isIdentifier(v)) return v;
    bad(v === undefined ? 'missing_field' : 'bad_identifier', path, 'a table or column must be a plain name');
    return null;
  };
  const label = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : fallback);
  const unique = (seen: Set<string>, k: string, path: string): boolean => {
    if (seen.has(k)) { bad('duplicate_key', path, `"${k}" is used twice`); return false; }
    seen.add(k);
    return true;
  };

  // Dimensions first, since streams and each other refer to them.
  const dimensions: ModelDimension[] = [];
  const dimKeys = new Set<string>();
  list(input.dimensions).forEach((raw, i) => {
    const path = `dimensions[${i}]`;
    if (!isRec(raw)) { bad('missing_field', path, 'a dimension must be an object'); return; }
    const k = key(raw.key, `${path}.key`);
    if (k === null || !unique(dimKeys, k, `${path}.key`)) return;
    const dim: ModelDimension = { key: k, label: label(raw.label, k), properties: [] };
    if (raw.table !== undefined) {
      const table = ident(raw.table, `${path}.table`);
      const code = ident(raw.code, `${path}.code`);
      if (table !== null && code !== null) { dim.table = table; dim.code = code; }
      if (raw.name !== undefined) { const name = ident(raw.name, `${path}.name`); if (name !== null) dim.name = name; }
    } else if (raw.code !== undefined || raw.name !== undefined || list(raw.properties).length > 0) {
      bad('dimension_table_incomplete', path, 'code, name and properties need a table');
    }
    const propKeys = new Set<string>(['code', 'name']);
    list(raw.properties).forEach((rawProp, j) => {
      const propPath = `${path}.properties[${j}]`;
      if (!isRec(rawProp)) { bad('missing_field', propPath, 'a property must be an object'); return; }
      const pk = key(rawProp.key, `${propPath}.key`);
      const column = ident(rawProp.column, `${propPath}.column`);
      if (pk === null || column === null || !unique(propKeys, pk, `${propPath}.key`)) return;
      dim.properties.push({ key: pk, label: label(rawProp.label, pk), column });
    });
    if (raw.via !== undefined && raw.via !== null) {
      if (!isRec(raw.via)) { bad('missing_field', `${path}.via`, 'via must be an object'); } else {
        const parent = key(raw.via.dimension, `${path}.via.dimension`);
        const column = ident(raw.via.column, `${path}.via.column`);
        if (parent !== null && column !== null) dim.via = { dimension: parent, column };
      }
    }
    dimensions.push(dim);
  });
  const dimByKey = new Map(dimensions.map((d) => [d.key, d]));
  dimensions.forEach((dim) => {
    if (!dim.via) return;
    const parent = dimByKey.get(dim.via.dimension);
    if (!parent) { bad('unknown_dimension', `dimensions.${dim.key}.via`, `no dimension "${dim.via.dimension}"`); return; }
    if (!parent.table) bad('via_parent_has_no_table', `dimensions.${dim.key}.via`, `"${parent.key}" has no table to hold "${dim.via.column}"`);
    const seen = new Set<string>([dim.key]);
    let cursor: ModelDimension | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.key)) { bad('dimension_cycle', `dimensions.${dim.key}.via`, 'the via chain loops back on itself'); break; }
      seen.add(cursor.key);
      cursor = cursor.via ? dimByKey.get(cursor.via.dimension) : undefined;
    }
  });

  const streams: ModelStream[] = [];
  const streamKeys = new Set<string>();
  list(input.streams).forEach((raw, i) => {
    const path = `streams[${i}]`;
    if (!isRec(raw)) { bad('missing_field', path, 'a stream must be an object'); return; }
    const k = key(raw.key, `${path}.key`);
    const table = ident(raw.table, `${path}.table`);
    const date = ident(raw.date, `${path}.date`);
    if (k === null || table === null || date === null || !unique(streamKeys, k, `${path}.key`)) return;
    const dimension_keys: Record<string, string> = {};
    Object.entries(isRec(raw.dimension_keys) ? raw.dimension_keys : {}).forEach(([dimKey, column]) => {
      const colPath = `${path}.dimension_keys.${dimKey}`;
      if (!dimByKey.has(dimKey)) { bad('unknown_dimension', colPath, `no dimension "${dimKey}"`); return; }
      const col = ident(column, colPath);
      if (col !== null) dimension_keys[dimKey] = col;
    });
    const columns: ModelStreamColumn[] = [];
    const columnKeys = new Set<string>();
    list(raw.columns).forEach((rawCol, j) => {
      const colPath = `${path}.columns[${j}]`;
      if (!isRec(rawCol)) { bad('missing_field', colPath, 'a stream column must be an object'); return; }
      const ck = key(rawCol.key, `${colPath}.key`);
      const col = ident(rawCol.column, `${colPath}.column`);
      if (ck === null || col === null || !unique(columnKeys, ck, `${colPath}.key`)) return;
      columns.push({ key: ck, label: label(rawCol.label, ck), column: col });
    });
    const rollups: ModelRollup[] = [];
    const rollupKeys = new Set<string>();
    list(raw.rollups).forEach((rawRollup, j) => {
      const rollupPath = `${path}.rollups[${j}]`;
      if (!isRec(rawRollup)) { bad('missing_field', rollupPath, 'a rollup must be an object'); return; }
      const rk = key(rawRollup.key, `${rollupPath}.key`);
      const rollupTable = ident(rawRollup.table, `${rollupPath}.table`);
      const rollupDate = ident(rawRollup.date, `${rollupPath}.date`);
      if (rk === null || rollupTable === null || rollupDate === null || !unique(rollupKeys, rk, `${rollupPath}.key`)) return;
      const kept: Record<string, string> = {};
      Object.entries(isRec(rawRollup.dimension_keys) ? rawRollup.dimension_keys : {}).forEach(([dimKey, column]) => {
        const colPath = `${rollupPath}.dimension_keys.${dimKey}`;
        if (!has(dimension_keys, dimKey)) { bad('rollup_dimension_not_on_stream', colPath, `the stream has no dimension "${dimKey}"`); return; }
        const col = ident(column, colPath);
        if (col !== null) kept[dimKey] = col;
      });
      // Which measures these may be is checked once the measures are read, below.
      const measure_columns: Record<string, string> = {};
      Object.entries(isRec(rawRollup.measure_columns) ? rawRollup.measure_columns : {}).forEach(([measureKey, column]) => {
        const col = ident(column, `${rollupPath}.measure_columns.${measureKey}`);
        if (col !== null) measure_columns[measureKey] = col;
      });
      rollups.push({ key: rk, table: rollupTable, date: rollupDate, dimension_keys: kept, measure_columns });
    });
    streams.push({ key: k, label: label(raw.label, k), table, date, dimension_keys, columns, rollups });
  });
  if (streams.length === 0 && problems.length === 0) bad('no_streams', 'streams', 'a model needs at least one stream');
  const defaultStream = streams[0]?.key;

  const measures: ModelMeasure[] = [];
  const measureKeys = new Set<string>();
  list(input.measures).forEach((raw, i) => {
    const path = `measures[${i}]`;
    if (!isRec(raw)) { bad('missing_field', path, 'a measure must be an object'); return; }
    const k = key(raw.key, `${path}.key`);
    if (k === null || !unique(measureKeys, k, `${path}.key`)) return;
    let format: MeasureFormat = 'number';
    if (raw.format !== undefined) {
      if ((MEASURE_FORMATS as readonly unknown[]).includes(raw.format)) format = raw.format as MeasureFormat;
      else bad('unknown_format', `${path}.format`, `format must be one of ${MEASURE_FORMATS.join(', ')}`);
    }
    const hasFormula = raw.formula !== undefined;
    const hasAgg = raw.agg !== undefined || raw.column !== undefined;
    if (hasFormula === hasAgg) { bad('measure_shape', path, 'a measure is either an agg over a column or a formula, not both and not neither'); return; }
    if (hasFormula) {
      if (typeof raw.formula !== 'string') { bad('formula_invalid', `${path}.formula`, 'a formula must be text'); return; }
      measures.push({ key: k, label: label(raw.label, k), formula: raw.formula, format });
      return;
    }
    if (!(MEASURE_AGGS as readonly unknown[]).includes(raw.agg)) { bad('unknown_agg', `${path}.agg`, `agg must be one of ${MEASURE_AGGS.join(', ')}`); return; }
    const agg = raw.agg as MeasureAgg;
    const stream = raw.stream === undefined ? defaultStream : raw.stream;
    if (typeof stream !== 'string' || !streamKeys.has(stream)) { bad('unknown_stream', `${path}.stream`, `no stream "${String(stream)}"`); return; }
    const measure: ModelBaseMeasure = { key: k, label: label(raw.label, k), agg, stream, format, snapshot: raw.snapshot === true };
    if (raw.column !== undefined || agg !== 'count') {
      const column = ident(raw.column, `${path}.column`);
      if (column === null) return;
      measure.column = column;
    }
    measures.push(measure);
  });

  // Formulas: each must parse, name only measures, and not loop.
  const measureByKey = new Map(measures.map((m) => [m.key, m]));

  // Rollups: each measure one carries must be its stream's own, and one that months can be added up to.
  streams.forEach((stream) => {
    stream.rollups.forEach((rollup) => {
      Object.keys(rollup.measure_columns).forEach((measureKey) => {
        const path = `streams.${stream.key}.rollups.${rollup.key}.measure_columns.${measureKey}`;
        const m = measureByKey.get(measureKey);
        if (!m || isFormulaMeasure(m) || m.stream !== stream.key) { bad('rollup_measure_unknown', path, `"${measureKey}" is not a base measure of this stream`); return; }
        if (m.snapshot || m.agg === 'count_distinct' || m.agg === 'avg') bad('rollup_measure_not_additive', path, 'a snapshot, a distinct count or an average cannot be rebuilt from months');
      });
    });
  });

  const refsOf = new Map<string, string[]>();
  measures.forEach((m) => {
    if (!isFormulaMeasure(m)) return;
    try {
      const refs = formulaRefs(parseFormula(m.formula));
      refsOf.set(m.key, refs);
      refs.forEach((ref) => {
        if (!measureByKey.has(ref)) bad('formula_unknown_measure', `measures.${m.key}.formula`, `"${ref}" is not a measure`);
      });
    } catch (err) {
      if (!(err instanceof ReportingError)) throw err;
      bad('formula_invalid', `measures.${m.key}.formula`, err.message);
    }
  });
  const state = new Map<string, 'open' | 'done'>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 'done') return true;
    if (state.get(k) === 'open') return false;
    state.set(k, 'open');
    const fine = (refsOf.get(k) ?? []).every(visit);
    state.set(k, 'done');
    return fine;
  };
  measures.forEach((m) => {
    if (isFormulaMeasure(m) && !visit(m.key)) bad('formula_cycle', `measures.${m.key}.formula`, 'the formula refers back to itself');
  });

  const rawPeriods: Rec = isRec(input.periods) ? input.periods : {};
  const fiscal = rawPeriods.fiscal_year_start_month === undefined ? 1 : rawPeriods.fiscal_year_start_month;
  if (typeof fiscal !== 'number' || !Number.isInteger(fiscal) || fiscal < 1 || fiscal > 12) bad('bad_fiscal_month', 'periods.fiscal_year_start_month', 'must be a whole number from 1 to 12');
  const weekStart = rawPeriods.week_start === undefined ? 'monday' : rawPeriods.week_start;
  if (weekStart !== 'monday' && weekStart !== 'sunday') bad('bad_week_start', 'periods.week_start', 'must be monday or sunday');
  const custom: NamedPeriod[] = [];
  const periodKeys = new Set<string>();
  list(rawPeriods.custom).forEach((raw, i) => {
    const path = `periods.custom[${i}]`;
    if (!isRec(raw)) { bad('missing_field', path, 'a named period must be an object'); return; }
    const k = key(raw.key, `${path}.key`);
    if (k === null || !unique(periodKeys, k, `${path}.key`)) return;
    const { from, to } = raw;
    if (!isIsoDate(from) || !isIsoDate(to)) { bad('bad_date', path, 'from and to must be YYYY-MM-DD'); return; }
    if (to < from) { bad('period_range_inverted', path, 'to is before from'); return; }
    custom.push({ key: k, label: label(raw.label, k), from, to });
  });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    model: {
      model_version: MODEL_VERSION,
      streams,
      dimensions,
      measures,
      periods: { fiscal_year_start_month: fiscal as number, week_start: weekStart as 'monday' | 'sunday', custom },
    },
  };
}

/**
 * Which measures a role can use, given the tables and columns its build holds.
 * A measure built on a column the role lacks is hidden, not shown as zero.
 */
export function measureAvailability(model: ReportingModel, schema: Record<string, readonly string[]>): Record<string, boolean> {
  const columns = new Map(Object.entries(schema).map(([table, cols]) => [table.toLowerCase(), new Set(cols.map((c) => c.toLowerCase()))]));
  const streamByKey = new Map(model.streams.map((s) => [s.key, s]));
  const measureByKey = new Map(model.measures.map((m) => [m.key, m]));
  const memo = new Map<string, boolean>();
  const available = (k: string, depth: number): boolean => {
    const known = memo.get(k);
    if (known !== undefined) return known;
    const m = measureByKey.get(k);
    let result = false;
    if (m && depth < 30) {
      if (isFormulaMeasure(m)) {
        try { result = formulaRefs(parseFormula(m.formula)).every((ref) => available(ref, depth + 1)); } catch { result = false; }
      } else {
        const stream = streamByKey.get(m.stream);
        const cols = stream ? columns.get(stream.table.toLowerCase()) : undefined;
        result = !!stream && !!cols && cols.has(stream.date.toLowerCase()) && (m.column === undefined || cols.has(m.column.toLowerCase()));
      }
    }
    memo.set(k, result);
    return result;
  };
  return Object.fromEntries(model.measures.map((m) => [m.key, available(m.key, 0)]));
}

/**
 * Test helpers for apps that write datasets: check rows against the app's
 * REAL manifest `datasets` entry, the way the platform's append route does,
 * so a doc field the manifest does not declare (objectID included) fails in
 * the app's own tests rather than on prod.
 *
 * Mirrors sprigr-team workers/provisioning/src/wfp-datasets-validation.ts
 * `validateDatasetRows` (row codes, the reserved envelope names, the keyed
 * tombstone, null handling, the ISO date check). Keep the two in step.
 */
import { MAX_APPEND_ROWS, type DatasetAppendResult, type DatasetRow, type SprigrDatasetsApi } from './index';

/** One manifest `datasets.<name>` entry, as much of it as row checks read. */
export interface DatasetDeclaration {
  mode?: 'append' | 'keyed' | 'snapshot' | string;
  key?: readonly string[];
  partition_key?: readonly string[];
  version_field?: string;
  fields: Record<string, { type: string } & Record<string, unknown>>;
}

/** A manifest, or anything else carrying its `datasets` map. */
export interface ManifestWithDatasets {
  datasets?: Record<string, DatasetDeclaration>;
}

/** Row-level refusal codes, the same the append route answers with. */
export type DatasetRowErrorCode = 'unknown_field' | 'reserved_field' | 'type_mismatch' | 'missing_key' | 'missing_partition' | 'bad_date';

export interface DatasetRowError {
  row: number;
  code: DatasetRowErrorCode;
  field: string;
}

/** Names the platform stamps on every stored row; a row may not carry them. */
export const DATASET_RESERVED_FIELDS: readonly string[] = ['company_id', 'install_id', 'app_slug', 'dataset', 'ingested_at', 'run_id'];
/** The row field that hides a key from a `keyed` dataset's current view. */
export const DATASET_TOMBSTONE_FIELD = '_deleted';

const RESERVED_SET: ReadonlySet<string> = new Set([...DATASET_RESERVED_FIELDS, DATASET_TOMBSTONE_FIELD]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_ROW_ERRORS = 50;

/** True for an ISO-8601 date or datetime string that also parses. */
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));
}

/**
 * Every disagreement between `rows` and one dataset declaration, up to 50.
 * A null value is always allowed (a missing value is not a type error); a
 * key or partition field may not be null.
 */
export function validateDatasetRows(decl: DatasetDeclaration, rows: readonly DatasetRow[]): DatasetRowError[] {
  const errors: DatasetRowError[] = [];
  const mode = decl.mode ?? 'append';
  const push = (e: DatasetRowError): void => {
    if (errors.length < MAX_ROW_ERRORS) errors.push(e);
  };
  rows.forEach((row, i) => {
    for (const [f, v] of Object.entries(row)) {
      if (f === DATASET_TOMBSTONE_FIELD && mode === 'keyed') {
        if (typeof v !== 'boolean') push({ row: i, code: 'type_mismatch', field: f });
        continue;
      }
      if (RESERVED_SET.has(f)) { push({ row: i, code: 'reserved_field', field: f }); continue; }
      const d = decl.fields[f];
      if (!d) { push({ row: i, code: 'unknown_field', field: f }); continue; }
      if (v === null || v === undefined) continue;
      if (d.type === 'string' && typeof v !== 'string') push({ row: i, code: 'type_mismatch', field: f });
      else if (d.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) push({ row: i, code: 'type_mismatch', field: f });
      else if (d.type === 'boolean' && typeof v !== 'boolean') push({ row: i, code: 'type_mismatch', field: f });
      else if (d.type === 'date' && !isIsoDate(v)) push({ row: i, code: 'bad_date', field: f });
    }
    if (mode === 'keyed') {
      for (const k of decl.key ?? []) {
        const v = row[k];
        if (v === null || v === undefined || String(v).trim() === '') push({ row: i, code: 'missing_key', field: k });
      }
    }
    for (const p of decl.partition_key ?? []) {
      if (row[p] === null || row[p] === undefined) push({ row: i, code: 'missing_partition', field: p });
    }
  });
  return errors;
}

/**
 * The whole append contract for one call: the dataset is declared, the call
 * carries 1 to 1,000 rows, and every row passes validateDatasetRows. Throws
 * an Error naming the first problem (`dataset_undeclared: x`,
 * `bad row count 0`, `unknown_field x.objectID (row 0)`, ...); returns
 * nothing when the platform would accept the call.
 */
export function checkAppend(manifest: ManifestWithDatasets, dataset: string, rows: readonly DatasetRow[]): void {
  const decl = manifest.datasets?.[dataset];
  if (!decl) throw new Error(`dataset_undeclared: ${dataset}`);
  if (rows.length === 0 || rows.length > MAX_APPEND_ROWS) throw new Error(`bad row count ${rows.length}`);
  const errors = validateDatasetRows(decl, rows);
  const first = errors[0];
  if (!first) return;
  const value = first.code === 'type_mismatch' || first.code === 'bad_date' ? `=${JSON.stringify(rows[first.row]?.[first.field])}` : '';
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  throw new Error(`${first.code} ${dataset}.${first.field}${value} (row ${first.row})${more}`);
}

/** One recorded append from fakeDatasets. */
export interface RecordedAppend {
  dataset: string;
  rows: DatasetRow[];
}

/**
 * A fake `env.SPRIGR.datasets` that runs checkAppend against the manifest
 * and records every accepted call. Refused calls throw, like the platform,
 * and are not recorded.
 */
export function fakeDatasets(manifest: ManifestWithDatasets): SprigrDatasetsApi & { appended: RecordedAppend[] } {
  const appended: RecordedAppend[] = [];
  return {
    appended,
    async append(dataset: string, rows: DatasetRow[]): Promise<DatasetAppendResult> {
      checkAppend(manifest, dataset, rows);
      appended.push({ dataset, rows });
      return { ok: true, rows: rows.length };
    },
  };
}

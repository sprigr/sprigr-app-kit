/**
 * Writing an install's datasets through `env.SPRIGR.datasets.append`
 * (decisions 0079 and 0115): rows stored as Parquet on R2 under the
 * install's prefix, validated against the manifest's `datasets` contract,
 * and read by the conform build through `app_dataset`. Never agent-readable.
 *
 * The platform takes at most 1,000 rows per append and throws on a refused
 * row. This package carries the pieces every dataset-writing app needs
 * around that call: turning index documents into keyed rows, retrying a
 * transient 5xx (and only a 5xx), and splitting a page into appends.
 *
 * The test helper that checks rows against a manifest's `datasets` entry
 * lives at `@sprigr/apps-datasets/testing`.
 */

/** What one append answers with. */
export interface DatasetAppendResult {
  ok: boolean;
  rows: number;
}

/**
 * The install's datasets surface, `env.SPRIGR.datasets`. Injected by the
 * marketplace runtime and absent under `next dev` and on a platform that
 * predates datasets, so bind it as optional on your env type.
 */
export interface SprigrDatasetsApi {
  append(dataset: string, rows: Record<string, unknown>[], opts?: { run_id?: string }): Promise<DatasetAppendResult>;
}

/** One dataset row: the fields the manifest declares for the dataset. */
export type DatasetRow = Record<string, unknown>;

/** The most rows one `datasets.append` call accepts. */
export const MAX_APPEND_ROWS = 1000;

/** Delays before each retry of a dataset append that failed with a
 *  server-side (5xx) error. Two retries, then the error is thrown. */
export const APPEND_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

/**
 * Index documents as keyed dataset rows: the deterministic `objectID`
 * becomes the dataset key `row_key` (a dataset may not carry `objectID`),
 * and `imported_at` is set to the import time as epoch ms, the keyed
 * version, so a re-import of the same key replaces the earlier row in the
 * current view. Any `imported_at` the doc already carries is overwritten.
 *
 * `importedAtMs` is one time for the whole page, or a function of the doc
 * when each doc carries its own import time.
 */
export function datasetRows<D extends { objectID: string }>(
  docs: ReadonlyArray<D>,
  importedAtMs: number | ((doc: D) => number),
): DatasetRow[] {
  return docs.map((doc) => {
    const { objectID, ...rest } = doc;
    const importedAt = typeof importedAtMs === 'function' ? importedAtMs(doc) : importedAtMs;
    return { row_key: objectID, ...rest, imported_at: importedAt };
  });
}

/** True for an append failure the platform or its storage reported as a
 *  5xx: `env.SPRIGR.datasets.append failed: 500 put: We encountered an
 *  internal error. Please try again. (10001)` is R2's transient error, seen
 *  by google-analytics on Showpo 2026-09-27 11:06Z. A 4xx
 *  (contract_violation, undeclared) is a real refusal and is never retried. */
export function isRetryableAppendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /failed: 5\d\d\b/.test(msg);
}

/** Thrown when an append answers `ok: false` (or nothing). Not retried. */
export class DatasetAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetAppendError';
  }
}

export interface AppendRetryOptions {
  /** Waits between retries. Defaults to setTimeout; pass a recorder in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay before each retry; its length is the retry count. Defaults to
   *  APPEND_RETRY_DELAYS_MS. */
  delays?: readonly number[];
  /** Prefix for the retry warning, e.g. `[ga4-import]`. Defaults to `[datasets]`. */
  logPrefix?: string;
  /** Throw DatasetAppendError when the append answers `ok: false` or nothing
   *  (default true). With false the answer is returned as-is. */
  requireOk?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One dataset append, retried on a 5xx. Without the retry a single transient
 * storage error fails the whole page. A retried batch is safe: rows are
 * keyed by `row_key`, so a batch that did land before the error is replaced,
 * not duplicated, in the current view. A 4xx, an `ok: false` answer, and a
 * 5xx that outlasts every retry are thrown.
 */
export async function appendWithRetry(
  datasets: SprigrDatasetsApi,
  dataset: string,
  rows: DatasetRow[],
  opts: AppendRetryOptions = {},
): Promise<DatasetAppendResult> {
  if (rows.length > MAX_APPEND_ROWS) {
    throw new RangeError(`append to ${dataset} has ${rows.length} rows; one append takes at most ${MAX_APPEND_ROWS} (use appendInBatches)`);
  }
  const delays = opts.delays ?? APPEND_RETRY_DELAYS_MS;
  const requireOk = opts.requireOk ?? true;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await datasets.append(dataset, rows);
      if (requireOk && (!res || res.ok === false)) {
        throw new DatasetAppendError(`append to ${dataset} returned ok:false for ${rows.length} rows`);
      }
      return res;
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryableAppendError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${opts.logPrefix ?? '[datasets]'} append to "${dataset}" failed (${msg.slice(0, 160)}); retry ${attempt + 1} in ${delay} ms`);
      await (opts.sleep ?? defaultSleep)(delay);
    }
  }
}

export interface AppendInBatchesOptions extends AppendRetryOptions {
  /** Rows per append, 1 to MAX_APPEND_ROWS (the default). */
  batchSize?: number;
  /** Appends in flight at once (default 1, one after another). Keep it
   *  small so one install never floods the platform's append route. */
  concurrency?: number;
}

/**
 * Append any number of rows as batches of at most `batchSize` rows, each
 * through appendWithRetry, `concurrency` at a time. Returns the rows the
 * platform reports stored. Rejects with the first failure, like Promise.all.
 * With `concurrency` 1 nothing is appended after a failure; with more, the
 * other workers keep draining the remaining batches before the rejection
 * settles (harmless, since rows are keyed, and the same as a plain
 * map-with-limit).
 */
export async function appendInBatches(
  datasets: SprigrDatasetsApi,
  dataset: string,
  rows: readonly DatasetRow[],
  opts: AppendInBatchesOptions = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? MAX_APPEND_ROWS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_APPEND_ROWS) {
    throw new RangeError(`batchSize must be an integer from 1 to ${MAX_APPEND_ROWS}; got ${batchSize}`);
  }
  const batches: DatasetRow[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
  const stored = new Array<number>(batches.length).fill(0);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const i = next++;
      const res = await appendWithRetry(datasets, dataset, batches[i]!, opts);
      stored[i] = res?.rows ?? 0;
    }
  };
  const width = Math.min(Math.max(1, opts.concurrency ?? 1), batches.length);
  await Promise.all(Array.from({ length: width }, worker));
  return stored.reduce((n, x) => n + x, 0);
}

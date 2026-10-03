/**
 * Deferred extractions: pptx and binaries of 16 MiB or more extract as a
 * durable platform job. The walk records a pending row (the full row JSON,
 * content empty, plus the job token); the drain polls the job on later ticks
 * and re-imports the row with the text attached.
 */

import type { Deadline } from '@sprigr/apps-fetch-budget';
import { capText } from './content';
import { importFileObjects, partitionValidObjects } from './import';
import { EXTRACTION_DRAIN_BUDGET_MS, MIN_ITEM_BUDGET_MS, remainingBudgetMs } from './tick-budget';
import type { FileIndexingEnv, FileIndexingStore, IndexedFileObject } from './types';

/** Pending rows polled per drain (one files.job read each, plus a re-import on success). */
export const MAX_EXTRACTION_POLLS_PER_RUN = 5;

/** Polls after which a still-unfinished job is dropped (about 2.5 h at a
 *  15-minute cadence); the file stays metadata-only. */
export const MAX_EXTRACTION_ATTEMPTS = 10;

/** A single poll at or above this is logged (sprigr-team#8043). */
export const SLOW_EXTRACTION_POLL_MS = 2_000;

/**
 * Drop the deferred extraction of every file just removed from the index, so
 * the drain cannot re-import a deleted file. Called after an index delete,
 * never before.
 */
export async function forgetPendingExtractions(store: FileIndexingStore, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  await store.deletePendingExtractions(objectIds);
}

/**
 * Bring each pending row's stored record up to date with what the walk is
 * about to import (sprigr-apps#2291). The drain imports `record_json` whole,
 * so a stale snapshot would put back an old name, path or acl_principals (a
 * user removed from a file would regain search access). An object imported
 * WITH content was extracted by this walk, so its job is dropped instead.
 *
 * Runs BEFORE the import (google-workspace's order): a refreshed snapshot that
 * was not imported is merely fresher than the index, while an import with a
 * stale snapshot left behind is exactly the reversion this exists to prevent.
 * A failure aborts the import and keeps the cursor.
 */
export async function refreshPendingExtractions(store: FileIndexingStore, objects: IndexedFileObject[]): Promise<void> {
  // Later occurrences win, as they do in the import.
  const latest = new Map<string, IndexedFileObject>();
  for (const obj of objects) latest.set(obj.objectID, obj);
  if (latest.size === 0) return;
  const pending = await store.listPendingExtractionsFor([...latest.keys()]);
  for (const row of pending) {
    const obj = latest.get(row.object_id);
    if (!obj) continue;
    if (typeof obj.content === 'string' && obj.content.length > 0) {
      await store.deletePendingExtraction(row.object_id);
      continue;
    }
    const recordJson = JSON.stringify(obj);
    if (recordJson !== row.record_json) await store.refreshPendingExtractionRecord(row.object_id, recordJson);
  }
}

export interface DrainOptions {
  /** A shared tick deadline. When absent the drain takes its OWN slice of
   *  `budgetMs` (default EXTRACTION_DRAIN_BUDGET_MS) starting now. */
  deadline?: Deadline;
  budgetMs?: number;
  /** Least time left to START another row (default MIN_ITEM_BUDGET_MS). A
   *  row is never started with 0 ms or less left, whatever this is: `0`
   *  behaves like `1` (sprigr-app-kit#99; 0.1.0 started a row with exactly
   *  0 ms left when this was 0). A row already in flight always finishes. */
  minItemMs?: number;
  now?: () => number;
  label?: string;
}

/**
 * Poll a bounded batch of deferred jobs and backfill their text. Per row:
 *   - done with text: set content (capped), re-import through the same
 *     validated withAcl path, delete the row;
 *   - error / not_found / too many attempts: delete the row (metadata-only);
 *   - still running: bump attempts and leave it.
 * A row whose stored record would fail principal validation can never be
 * imported, so it is dropped rather than polled forever. Never throws; returns
 * how many rows were backfilled.
 */
export async function drainPendingExtractions(
  store: FileIndexingStore,
  env: FileIndexingEnv,
  opts: DrainOptions = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const label = opts.label ?? '[file-indexing]';
  const deadline: Deadline = opts.deadline ?? { at: now() + (opts.budgetMs ?? EXTRACTION_DRAIN_BUDGET_MS) };
  const minItemMs = opts.minItemMs ?? MIN_ITEM_BUDGET_MS;
  const files = env.SPRIGR?.files;
  if (!files || typeof files.job !== 'function') {
    console.warn(`${label} pending-extraction drain skipped: env.SPRIGR.files.job unavailable (wrapper predates the job-poll surface)`);
    return 0;
  }
  let pending: Awaited<ReturnType<FileIndexingStore['listPendingExtractions']>>;
  try {
    pending = await store.listPendingExtractions(MAX_EXTRACTION_POLLS_PER_RUN);
  } catch (err) {
    console.warn(`${label} pending-extraction drain: listing failed; skipping this run:`, err instanceof Error ? err.message : String(err));
    return 0;
  }
  let backfilled = 0;
  let deferred = 0;
  for (const [i, row] of pending.entries()) {
    // `<= 0` as well as the floor: with minItemMs 0, budgetBelow alone
    // (`remaining < 0`) would start a row at exactly the deadline.
    const left = remainingBudgetMs(deadline, now);
    if (left <= 0 || left < minItemMs) {
      deferred = pending.length - i;
      break;
    }
    try {
      const started = now();
      const job = await files.job(row.job_token);
      const pollMs = now() - started;
      if (pollMs >= SLOW_EXTRACTION_POLL_MS) {
        console.warn(`${label} pending-extraction drain: slow poll ${pollMs}ms for ${row.object_id}`);
      }
      const result = job.status === 'done' ? (job.result as { ok?: boolean; text?: unknown; truncated?: unknown } | undefined) : undefined;
      const text = result && result.ok === true && typeof result.text === 'string' ? result.text : null;
      if (job.status === 'done' && text !== null) {
        let record: IndexedFileObject;
        try {
          record = JSON.parse(row.record_json) as IndexedFileObject;
        } catch (err) {
          console.warn(
            `${label} pending-extraction drain: unparseable record_json for ${row.object_id}; dropping:`,
            err instanceof Error ? err.message : String(err),
          );
          await store.deletePendingExtraction(row.object_id);
          continue;
        }
        if (partitionValidObjects([record]).valid.length === 0) {
          console.warn(`${label} pending-extraction drain: stored record for ${row.object_id} fails principal validation; dropping`);
          await store.deletePendingExtraction(row.object_id);
          continue;
        }
        record.content = capText(text, { label, what: row.object_id, alreadyTruncated: result?.truncated === true });
        await importFileObjects(env, [record], { label });
        await store.deletePendingExtraction(row.object_id);
        backfilled++;
        continue;
      }
      if (job.status === 'error' || job.status === 'not_found' || row.attempts + 1 >= MAX_EXTRACTION_ATTEMPTS) {
        console.warn(
          `${label} pending-extraction drain: dropping ${row.object_id} (status=${job.status}, attempts=${row.attempts}); file stays metadata-only`,
        );
        await store.deletePendingExtraction(row.object_id);
        continue;
      }
      await store.bumpPendingExtraction(row.object_id);
    } catch (err) {
      // Left untouched: a transient poll error does not count against the give-up budget.
      console.warn(
        `${label} pending-extraction drain: error handling ${row.object_id}; leaving it queued:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (backfilled > 0) console.log(`${label} pending-extraction drain: backfilled ${backfilled} record(s)`);
  if (deferred > 0) console.warn(`${label} pending-extraction drain: deferred ${deferred} row(s) at its budget; they stay queued`);
  return backfilled;
}

/**
 * Content fills (sprigr-apps#2702): files a pass imported WITHOUT their text.
 *
 * A pass stops fetching content at its deadline, after MAX_EXTRACTIONS_PER_RUN
 * binaries, and for a drive that answered 429. Before 0.1.2 those files were
 * imported metadata-only, the cursor moved past them, and nothing came back
 * for them until they next changed: a 300-file burst into Dropbox left 215
 * files searchable by name only, with the status still `ok`, and agents then
 * told users the text did not exist.
 *
 * Now each such file is recorded in the app's existing pending-extraction
 * table (no migration) under a content-fill token, `content-fill:<walkKey>`,
 * so the rows belong to the scope that can fetch them. Every rule the package
 * already applies to that table holds for them: a walk that imports the file
 * WITH text drops the row, a walk that re-imports it without text refreshes
 * the stored record (new revision, name, path and principals), a deleted file
 * forgets its row, and the reconcile and the disconnect purge remove them.
 *
 * The drain runs at the end of every indexing pass of the same scope, inside
 * whatever is left of the pass deadline and its own slice
 * (CONTENT_FILL_BUDGET_MS), so it never makes a pass longer than its
 * deadline. Per row it re-reads the file when the adapter has `refetchEntry`
 * (a vanished file is dropped; the row is re-stamped from the current entry,
 * so text never lands under principals the file no longer has), fetches the
 * text the same way the walk does, and imports the row through the validated
 * withAcl path. The cursor is never touched: the cursor may advance, and this
 * queue carries the gap.
 */

import type { Deadline } from '@sprigr/apps-fetch-budget';
import {
  MAX_EXTRACTIONS_PER_RUN,
  contentKindFor,
  fetchObjectContent,
  type ExtractionBudget,
} from './content';
import { importFileObjects, partitionValidObjects } from './import';
import { stampEntries } from './stamp';
import { MIN_ITEM_BUDGET_MS, remainingBudgetMs } from './tick-budget';
import type {
  FileIndexingContext,
  FileIndexingScope,
  FileIndexingStore,
  FileSourceAdapter,
  IndexedFileObject,
  PendingExtractionRow,
} from './types';

/** Marks a pending row as a content fill, not a platform extraction job. */
export const CONTENT_FILL_TOKEN_PREFIX = 'content-fill:';

/** The content-fill drain's own slice per pass. The pass deadline still
 *  bounds it: the drain starts no row once either is spent. */
export const CONTENT_FILL_BUDGET_MS = 15_000;

/** Rows one pass's drain reads (and at most fills). */
export const MAX_CONTENT_FILLS_PER_PASS = 100;

/** Failed fetches after which a fill is dropped and the file stays
 *  metadata-only until it next changes (logged). */
export const MAX_CONTENT_FILL_ATTEMPTS = 5;

/** The token every content-fill row of one scope carries. */
export function contentFillToken(walkKey: string): string {
  return `${CONTENT_FILL_TOKEN_PREFIX}${walkKey}`;
}

export function isContentFillToken(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(CONTENT_FILL_TOKEN_PREFIX);
}

/** Whether a store can hold and drain content fills. */
export function storeSupportsContentFills(store: FileIndexingStore): boolean {
  return typeof store.listPendingContentFills === 'function';
}

/**
 * Record files for a later content fill. A file that already has a pending
 * row that is NOT a content fill (a platform extraction job, an app's own
 * queue such as Dropbox's Riviera rows) is left alone: that job is already
 * getting its text, and overwriting the token would lose it. Never throws: a
 * write failure comes back in `error`.
 */
export async function recordContentFills(
  store: FileIndexingStore,
  ctx: Pick<FileIndexingContext, 'walkKey'>,
  items: Array<{ object: IndexedFileObject; mime: string }>,
  opts: { label?: string } = {},
): Promise<{ recorded: number; error?: string }> {
  const label = opts.label ?? '[file-indexing]';
  if (items.length === 0) return { recorded: 0 };
  if (!storeSupportsContentFills(store)) {
    console.warn(
      `${label} ${items.length} file(s) import without their text and cannot be queued for a content fill: the store has no content-fill methods (createD1FileIndexingStore has them)`,
    );
    return { recorded: 0 };
  }
  if (!ctx.walkKey) return { recorded: 0, error: 'no walk key for this scope' };
  const token = contentFillToken(ctx.walkKey);
  try {
    // Later occurrences win, as they do in the import.
    const latest = new Map<string, { object: IndexedFileObject; mime: string }>();
    for (const it of items) latest.set(it.object.objectID, it);
    const existing = await store.listPendingExtractionsFor([...latest.keys()]);
    let unchanged = 0;
    const known = new Map<string, string>();
    for (const row of existing) {
      if (!isContentFillToken(row.job_token)) latest.delete(row.object_id);
      else if (row.job_token === token) known.set(row.object_id, row.record_json);
    }
    const rows: Array<{ objectId: string; jobToken: string; recordJson: string; format: string }> = [];
    for (const { object, mime } of latest.values()) {
      const recordJson = JSON.stringify(object);
      // Already queued with this very record (a re-listed scope defers the
      // same tail every pass): no write, D1 bills every row written.
      if (known.get(object.objectID) === recordJson) {
        unchanged++;
        continue;
      }
      rows.push({ objectId: object.objectID, jobToken: token, recordJson, format: mime });
    }
    if (rows.length > 0) {
      if (store.upsertPendingContentFills) await store.upsertPendingContentFills(rows);
      else for (const row of rows) await store.upsertPendingExtraction(row);
    }
    return { recorded: rows.length + unchanged };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`${label} recording ${items.length} content fill(s) failed: ${detail}`);
    return { recorded: 0, error: detail };
  }
}

/**
 * Files of this scope waiting for their text: searchable by name only until
 * the drain fills them. Null when the store cannot count them.
 */
export async function countPendingContentFills(
  store: FileIndexingStore,
  scope: FileIndexingScope,
): Promise<number | null> {
  if (!store.countPendingContentFills) return null;
  const walkKey = store.walkKey(scope);
  if (!walkKey) return 0;
  return store.countPendingContentFills(contentFillToken(walkKey));
}

/**
 * What a status tool should say about a content backlog, or null when there
 * is none. Written for the agent reading the status: on sprigr-apps#2702 an
 * agent searched the index, found nothing, saw "ok" and told the user the
 * text did not exist.
 */
export function describeContentPending(count: number | null | undefined): string | null {
  if (!count || count <= 0) return null;
  const head =
    count === 1
      ? '1 file is searchable by name only until its text is processed'
      : `${count} files are searchable by name only until their text is processed`;
  return `${head}; a search by what a file says can miss it until then, so read the file itself before saying its text does not exist.`;
}

export interface ContentFillOptions {
  /** The pass deadline. No row starts once it, or the drain's own slice, is spent. */
  deadline?: Deadline;
  /** The drain's own slice (default CONTENT_FILL_BUDGET_MS). */
  budgetMs?: number;
  /** Rows read per drain (default MAX_CONTENT_FILLS_PER_PASS). */
  maxFills?: number;
  /** Least time left to START a row (default MIN_ITEM_BUDGET_MS; never below 1). */
  minItemMs?: number;
  /** The pass's extraction counter, so the binary cap stays per pass. */
  budget?: ExtractionBudget;
  /** Throttle keys that answered 429 this pass; they are not asked again. */
  throttled?: Set<string>;
  label?: string;
}

export interface ContentFillOutcome {
  /** Rows read from the queue. */
  considered: number;
  /** Rows whose text was imported. */
  filled: number;
  /** Rows turned into a durable platform extraction job (pptx, very large). */
  converted: number;
  /** Rows dropped: the file vanished, is no longer eligible, lost every
   *  principal, its fetch failed MAX_CONTENT_FILL_ATTEMPTS times, or its text
   *  came back empty. */
  dropped: number;
  /** Rows left for a later pass: throttled, budget, a failure that may pass. */
  waiting: number;
  /** Rows not started because the deadline or slice was spent. */
  deferred: number;
  error?: string;
}

const emptyFillOutcome = (): ContentFillOutcome => ({ considered: 0, filled: 0, converted: 0, dropped: 0, waiting: 0, deferred: 0 });

/**
 * Fill a bounded batch of this scope's waiting rows. Called by
 * indexActorFiles at the end of each pass (inside the adapter's runExclusive
 * lease, when it has one); call it directly only under the same serialisation.
 * Never throws.
 */
export async function drainContentFills<TEntry>(
  adapter: FileSourceAdapter<TEntry, any>,
  store: FileIndexingStore,
  ctx: FileIndexingContext,
  opts: ContentFillOptions = {},
): Promise<ContentFillOutcome> {
  const label = opts.label ?? adapter.logLabel ?? '[file-indexing]';
  const out = emptyFillOutcome();
  if (!store.listPendingContentFills || !ctx.walkKey) return out;
  const now = ctx.now;
  const sliceAt = now() + (opts.budgetMs ?? CONTENT_FILL_BUDGET_MS);
  const deadline: Deadline = { at: opts.deadline ? Math.min(opts.deadline.at, sliceAt) : sliceAt };
  const minItemMs = Math.max(1, opts.minItemMs ?? MIN_ITEM_BUDGET_MS);
  const budget = opts.budget ?? { extracted: 0, deferred: 0 };
  const throttled = opts.throttled ?? new Set<string>();
  const token = contentFillToken(ctx.walkKey);

  let rows: PendingExtractionRow[];
  try {
    if (remainingBudgetMs(deadline, now) < minItemMs) return out;
    rows = await store.listPendingContentFills(token, opts.maxFills ?? MAX_CONTENT_FILLS_PER_PASS);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    console.warn(`${label} content-fill drain: listing failed; skipping this pass: ${out.error}`);
    return out;
  }
  out.considered = rows.length;

  const drop = async (row: PendingExtractionRow, why: string): Promise<void> => {
    console.warn(`${label} content fill dropped for ${row.object_id}: ${why}`);
    await store.deletePendingExtraction(row.object_id);
    out.dropped++;
  };
  const retry = async (row: PendingExtractionRow, why: string): Promise<void> => {
    if (row.attempts + 1 >= MAX_CONTENT_FILL_ATTEMPTS) {
      await drop(row, `${why}; gave up after ${row.attempts + 1} attempts, the file stays searchable by name only until it changes`);
      return;
    }
    await store.bumpPendingExtraction(row.object_id);
    out.waiting++;
  };

  const ready: Array<{ row: PendingExtractionRow; object: IndexedFileObject }> = [];
  for (const [i, row] of rows.entries()) {
    const left = remainingBudgetMs(deadline, now);
    if (left <= 0 || left < minItemMs) {
      out.deferred = rows.length - i;
      break;
    }
    try {
      let object: IndexedFileObject;
      try {
        object = JSON.parse(row.record_json) as IndexedFileObject;
      } catch {
        await drop(row, 'unparseable stored record');
        continue;
      }
      let mime = row.format;
      if (adapter.refetchEntry) {
        let entry: TEntry | null;
        try {
          entry = await adapter.refetchEntry(object, ctx);
        } catch (err) {
          await retry(row, `re-reading the file failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (entry === null) {
          await drop(row, 'the file no longer exists');
          continue;
        }
        const stamped = await stampEntries(adapter, ctx, [entry]);
        if (stamped.unresolved > 0) {
          // Permissions could not be read right now: never import on a guess.
          await retry(row, 'its permissions could not be read');
          continue;
        }
        const fresh = stamped.objects[0];
        if (!fresh || fresh.objectID !== row.object_id) {
          await drop(row, fresh ? `the file now maps to ${fresh.objectID}` : 'no principal may see it now');
          continue;
        }
        object = fresh;
        mime = stamped.mimes[0]?.[1] ?? mime;
      } else if (partitionValidObjects([object]).valid.length === 0) {
        await drop(row, 'the stored record fails principal validation');
        continue;
      }
      const kind = contentKindFor(adapter, ctx, object, mime);
      if (!kind) {
        await drop(row, 'the file no longer qualifies for text (type, size or route)');
        continue;
      }
      const throttleKey = adapter.throttleKeyOf ? adapter.throttleKeyOf(object) : String(object.driveId ?? '');
      if (throttled.has(throttleKey)) {
        out.waiting++;
        continue;
      }
      if (kind.kind === 'binary') {
        if (budget.extracted >= MAX_EXTRACTIONS_PER_RUN) {
          budget.deferred++;
          out.waiting++;
          continue;
        }
        budget.extracted++;
      }
      const got = await fetchObjectContent(adapter, ctx, object, mime, kind);
      if (got.status === 'filled') {
        if (got.text.length === 0) {
          // Nothing to add: the row already holds empty content.
          await store.deletePendingExtraction(row.object_id);
          out.dropped++;
          continue;
        }
        object.content = got.text;
        ready.push({ row, object });
        continue;
      }
      if (got.status === 'job') {
        object.content = '';
        await store.upsertPendingExtraction({
          objectId: row.object_id,
          jobToken: got.jobToken,
          recordJson: JSON.stringify(object),
          format: kind.kind === 'binary' ? kind.format : mime,
        });
        out.converted++;
        continue;
      }
      if (got.status === 'throttled') {
        throttled.add(throttleKey);
        console.warn(`${label} ${throttleKey} is rate-limited (429); content fills for it wait for a later pass`);
        out.waiting++;
        continue;
      }
      if (got.status === 'missing') {
        await drop(row, 'the source says the file no longer exists');
        continue;
      }
      await retry(row, 'the content fetch failed');
    } catch (err) {
      // A store write failed: leave the row as it is for the next pass.
      console.warn(
        `${label} content-fill drain: error handling ${row.object_id}; leaving it queued:`,
        err instanceof Error ? err.message : String(err),
      );
      out.waiting++;
    }
  }

  if (ready.length > 0) {
    try {
      await importFileObjects(
        ctx.env,
        ready.map((r) => r.object),
        { label },
      );
      await store.deletePendingExtractions(ready.map((r) => r.row.object_id));
      out.filled = ready.length;
    } catch (err) {
      // The import (or the cleanup after it) failed: the rows stay queued and
      // are fetched again next pass. Not counted against their attempts.
      out.error = `content_fill_import_failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`${label} ${out.error}; ${ready.length} row(s) stay queued`);
      out.waiting += ready.length;
    }
  }
  if (out.filled > 0 || out.dropped > 0 || out.deferred > 0) {
    console.log(
      `${label} content-fill drain: filled ${out.filled}, converted ${out.converted}, dropped ${out.dropped}, waiting ${out.waiting}, not started ${out.deferred}`,
    );
  }
  return out;
}

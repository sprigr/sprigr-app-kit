/**
 * Self-paging resumable backfill primitive.
 *
 * Each invocation processes ONE page and advances the cursor in
 * `SyncState`. If the provider returns `nextCursor: null`, the
 * walk is done. Otherwise the caller is expected to schedule
 * another invocation (typically via `env.SPRIGR.schedules.create
 * ({fireAt: now + gapMs})`).
 *
 * Why one-page-per-invocation instead of an internal loop:
 *   The marketplace runtime's wrapper enforces a wall-clock budget
 *   per dispatch (~25s on App Bridge tool calls). A long-running
 *   backfill loop would time out. Splitting into many short
 *   invocations keeps each within budget and lets the runtime
 *   schedule retries on transient errors without rewinding the
 *   whole walk.
 *
 * Failure semantics:
 *   - fetchPage throws  cursor is NOT advanced. Next invocation
 *     re-reads the same cursor and retries.
 *   - writeRows throws  cursor is NOT advanced. Same as above.
 *   - All three steps succeed  cursor is written. Next invocation
 *     starts from `nextCursor`.
 *   - If `nextCursor` equals the cursor we just read, the walker
 *     refuses to advance and returns `done: true` so callers cannot
 *     accidentally loop on a stuck provider.
 *
 * End of a walk: what gets STORED (read this before choosing a cursor):
 *   - Returning `nextCursor: null` on the last page RESETS the stored
 *     cursor to null (null differs from the cursor just read, so it is
 *     treated as an advance and persisted). The next invocation then
 *     starts from the very first page again.
 *   - That is right for a FULL walk that should restart each pass (page
 *     numbers or offsets; quickbooks and xero-accounting rely on it).
 *   - It is WRONG for an ORDERED-STREAM walk whose cursor is a position
 *     to resume from (e.g. `sortKey: UPDATED_AT` + an opaque `after`
 *     cursor). There, return the last page's cursor on the final page,
 *     and on an empty page return the cursor you were given. The walker
 *     reads "not advanced" as done and keeps the stored position, so the
 *     next invocation asks only for what changed after it.
 *     sprigr-apps#3266: shopify returned null on its last page, so its
 *     hourly restate reset to the oldest order every time it caught up and
 *     re-walked the store's whole history.
 *
 * Typical wiring (app supplies the provider-specific fetch + write):
 *
 *   const state = makeSyncState({ db: env.DB, table: 'sync_state' });
 *   const result = await runResumablePage({
 *     state, resource: 'orders', scope: workspaceId,
 *     fetchPage: (cursor) => myProvider.listOrders({ cursor }),
 *     writeRows: (rows) => upsertOrders(env.DB, rows),
 *   });
 *   if (!result.done) {
 *     await env.SPRIGR.schedules.create({
 *       name: `sync_orders_${workspaceId}`,
 *       fireAt: new Date(Date.now() + 5_000).toISOString(),
 *       tool: 'continue_sync',
 *       prompt: JSON.stringify({ resource: 'orders', scope: workspaceId }),
 *     });
 *   }
 */

import type { SyncState } from './sync-state';

export interface RunResumablePageOpts<TRow> {
  state: SyncState;
  resource: string;
  scope?: string;
  fetchPage: (cursor: string | null) => Promise<FetchPageResult<TRow>>;
  writeRows: (rows: TRow[]) => Promise<void>;
}

export interface FetchPageResult<TRow> {
  rows: TRow[];
  /**
   * Where the next invocation starts. `null` ends the walk AND resets the
   * stored cursor, so the next walk starts from the first page. For a
   * resumable ordered stream, return the last cursor instead (see "End of a
   * walk" above).
   */
  nextCursor: string | null;
}

export interface RunResumablePageResult {
  rowsThisPage: number;
  done: boolean;
  nextCursor: string | null;
}

export async function runResumablePage<TRow>(
  opts: RunResumablePageOpts<TRow>,
): Promise<RunResumablePageResult> {
  const { state, resource, scope, fetchPage, writeRows } = opts;
  const existing = await state.read(resource, scope);
  const startCursor = existing?.cursor ?? null;

  const { rows, nextCursor } = await fetchPage(startCursor);
  await writeRows(rows);

  // Guard against a provider that keeps returning the same cursor.
  // Treat "no advance" as done so we don't loop forever.
  const advanced = nextCursor !== startCursor;
  const done = nextCursor == null || !advanced;

  // Always persist a sync_state row, even when the cursor didn't
  // advance (single-page dataset OR completed walk). The previous
  // behaviour skipped the write when `!advanced`, which left zero
  // bookkeeping rows after a successful one-page backfill — observers
  // couldn't tell whether the sync had ever run. The write is
  // idempotent (`ON CONFLICT(resource, scope) DO UPDATE`) and refreshes
  // `last_run_at` either way, so callers can answer "when did this
  // resource last sync" from the row.
  const persistCursor = advanced ? nextCursor : startCursor;
  await state.write(resource, scope, persistCursor);

  return {
    rowsThisPage: rows.length,
    done,
    nextCursor: done ? null : nextCursor,
  };
}

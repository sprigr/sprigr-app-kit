/**
 * @sprigr/apps-sync-cursor
 *
 * Resumable backfill primitive. Two pieces:
 *
 *   `makeSyncState({db, table})`  per-install cursor state via D1.
 *   `runResumablePage({...})`     process one page, advance cursor,
 *                                 caller schedules the next invocation.
 *
 * See `sync-state.ts` for schema, `page-walker.ts` for failure semantics
 * and a typical wiring example.
 */

export { makeSyncState } from './sync-state';
export type { SyncState, SyncStateRow, MakeSyncStateOpts } from './sync-state';

export { runResumablePage } from './page-walker';
export type {
  RunResumablePageOpts,
  RunResumablePageResult,
  FetchPageResult,
} from './page-walker';

export type { D1Like, D1PreparedStatementLike } from './types';

/**
 * @sprigr/apps-sync-cursor
 *
 * Resumable backfill primitives. Three pieces:
 *
 *   `makeSyncState({db, table})`  per-install cursor state via D1.
 *   `runResumablePage({...})`     process one page, advance cursor,
 *                                 caller schedules the next invocation.
 *   `runBackfillStep` / `startBackfill`
 *                                 a row backfill inside the install's own D1
 *                                 as a durable job: dry run, apply, verify
 *                                 (sprigr-team decision 0291).
 *
 * See `sync-state.ts` for schema, `page-walker.ts` for failure semantics
 * and a typical wiring example, `backfill.ts` for the backfill job.
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

export {
  runBackfillStep,
  startBackfill,
  backfillFingerprint,
  backfillVerified,
  BACKFILL_INITIAL_BATCH,
} from './backfill';
export type {
  BackfillMode,
  BackfillRow,
  BackfillSpec,
  BackfillParams,
  BackfillState,
  BackfillResult,
  BackfillJobInput,
  BackfillDirective,
  BackfillJobsBinding,
  RunBackfillStepOpts,
  StartBackfillOpts,
  StartBackfillResult,
  D1BatchLike,
} from './backfill';

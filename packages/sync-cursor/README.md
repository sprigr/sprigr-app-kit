# @sprigr/apps-sync-cursor

Resumable walks for Sprigr marketplace apps.

```bash
npm install @sprigr/apps-sync-cursor   # exact-pin it, like every @sprigr/apps-* package
```

| Piece | For |
|---|---|
| `makeSyncState` + `runResumablePage` | Paging through a **provider's** API across many invocations, with the cursor kept in your install's D1. See `src/page-walker.ts` for the failure semantics and when a null `nextCursor` resets the walk. |
| `runBackfillStep` + `startBackfill` | Filling a new column (or any row change) **inside your install's own D1** as a platform durable job, with a dry run first. |

## Backfills (sprigr-team decision 0291)

A migration file may only hold constant-time DDL (`CREATE TABLE`, `ADD COLUMN`, a rename). Work that grows with rows, such as filling a new column, is a backfill job, so a large install's live database is never held by one long statement.

```ts
import { runBackfillStep, startBackfill, backfillVerified, type BackfillSpec } from '@sprigr/apps-sync-cursor';

export const JOBS_STATUS_CODE: BackfillSpec = {
  name: 'jobs_status_code',
  version: '1',                      // bump whenever apply changes
  table: 'jobs',
  primaryKey: 'id',
  pending: 'status_code IS NULL',    // true while a row is on the OLD shape
  columns: ['status'],
  apply: (db, rows) => rows.map((r) =>
    // re-check `pending`, so a re-run batch changes nothing twice
    db.prepare('UPDATE jobs SET status_code = ? WHERE id = ? AND (status_code IS NULL)')
      .bind(r.status === 'closed' ? 2 : 1, r.id)),
};

// The job's step tool (manifest: jobs[{ name: 'backfill', tool: 'backfill_step', max_steps: ... }]).
export default (args) => runBackfillStep({ db: env.DB, spec: JOBS_STATUS_CODE, job: args.job });

// 1. Dry run: writes nothing; its result has scanned, pending and samples.
await startBackfill(env.SPRIGR.jobs, { jobName: 'backfill', spec: JOBS_STATUS_CODE, mode: 'dry_run' });
// 2. A person reads the counts and samples. Then apply, naming that dry run:
await startBackfill(env.SPRIGR.jobs, { jobName: 'backfill', spec: JOBS_STATUS_CODE, mode: 'apply', approvedDryRunJobId });
// 3. Verify before the contract release drops the old shape:
backfillVerified(verifyResult); // true only when pending is 0
```

What it guarantees:

- **Dry run first.** `startBackfill` refuses an apply unless `approvedDryRunJobId` is a completed dry run of the same spec and version, finished within 7 days (`maxDryRunAgeMs`). One apply per approved dry run: a repeat start returns the first run.
- **Bounded reads.** Every statement is a primary-key keyset window with a `LIMIT`. There is no `COUNT(*)` over the table and no `OFFSET`, so no statement can approach the CPU limit that resets a D1 database.
- **Idempotent and resumable.** The cursor and totals are the job's `state`, persisted by the platform after each step. A step that ran and never returned runs again from the last state, and the `pending` re-check makes it a no-op for rows already done.
- **Inside the limits.** Batches start at 1,000 rows and are resized toward 500 ms. A step stops before its time budget (20 s) and before 900 statements, under D1's 1,000 per invocation. A batch too big to write is halved, and that size becomes its cap.
- **Fails, never guesses.** A spec that changed since the run started (a different fingerprint), an apply with no approved dry run, or a non-identifier table or column fails the job non-retryably.

Size `max_steps` for the table: the platform caps a job at 450 steps, and each step walks up to about 20 s of batches.

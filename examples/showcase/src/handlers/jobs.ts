/**
 * Showcase - durable job STEP FUNCTION (`showcase_backfill_step`).
 *
 * A job is a long-running, resumable unit of work the platform drives one
 * step at a time. Each dispatch carries { job: { id, name, step, attempt,
 * params, state, signal? } }; the handler does ONE increment of work and
 * returns an AppJobDirective:
 *
 *   { op: 'continue', state?, label? }                     persist + next step
 *   { op: 'sleep', seconds, state?, label? }               persist + sleep + next
 *   { op: 'wait', reason?, timeout_seconds?, state?, label? } park until signal
 *   { op: 'complete', result? }                            job done
 *   { op: 'fail', error?, retryable? }                     job failed
 *
 * This step drives the whole directive set FROM job state:
 *   phase 'backfill' -> walk one Acme page via sync-cursor, sleep between pages
 *   phase 'await_approval' -> wait for an operator jobs.signal (or timeout)
 *   phase 'done' -> complete
 *
 * Handlers run AT-LEAST-ONCE per step and must be idempotent within a step.
 * The page walk + cursor write are local (env.DB + sync-cursor); the actual
 * page fetch would hit the provider (stubbed here so `sprigr app dev` can
 * still drive the state machine).
 */

import { makeSyncState, runResumablePage } from '@sprigr/apps-sync-cursor';
import type { ShowcaseEnv } from '../lib/env';

interface JobState {
  phase?: 'backfill' | 'await_approval' | 'done';
  pagesWalked?: number;
  rowsSeen?: number;
}

interface JobDispatch {
  job: {
    id: string;
    name: string;
    step: number;
    attempt: number;
    params?: { window_days?: number; max_pages?: number };
    state?: JobState;
    signal?: { payload?: unknown } | null;
  };
}

export type JobDirective =
  | { op: 'continue'; state?: JobState; label?: string }
  | { op: 'sleep'; seconds: number; state?: JobState; label?: string }
  | { op: 'wait'; reason?: string; timeout_seconds?: number; state?: JobState; label?: string }
  | { op: 'complete'; result?: unknown }
  | { op: 'fail'; error?: string; retryable?: boolean };

/** Stubbed provider page fetch — replace with a real api.acme.example call. */
async function fetchAcmePage(cursor: string | null): Promise<{ rows: Array<{ objectID: string }>; nextCursor: string | null }> {
  const pageNum = cursor ? Number(cursor) : 0;
  if (pageNum >= 2) return { rows: [], nextCursor: null }; // 3-page synthetic dataset
  const rows = [{ objectID: `contact_${pageNum}_a` }, { objectID: `contact_${pageNum}_b` }];
  return { rows, nextCursor: String(pageNum + 1) };
}

export async function runBackfillStep(env: ShowcaseEnv, dispatch: JobDispatch): Promise<JobDirective> {
  const { job } = dispatch;
  const state: JobState = job.state ?? {};
  const phase = state.phase ?? 'backfill';
  const maxPages = job.params?.max_pages ?? 3;

  try {
    if (phase === 'backfill') {
      // Walk exactly one page; sync-cursor persists the cursor to D1 so a
      // retried step resumes at the same place (idempotent within a step).
      const syncState = makeSyncState({ db: env.DB, table: 'showcase_sync_state' });
      let rowsThisPage = 0;
      let done = false;
      const result = await runResumablePage<{ objectID: string }>({
        state: syncState,
        resource: 'contacts',
        scope: 'backfill',
        fetchPage: (cursor) => fetchAcmePage(cursor),
        writeRows: async (rows) => {
          // On the platform: env.SPRIGR.data.import(rows). Kept local here so
          // the walker drives cleanly under `sprigr app dev`; the staging
          // path is exercised by the dispatcher/webhook handlers.
          rowsThisPage = rows.length;
        },
      });
      rowsThisPage = result.rowsThisPage;
      done = result.done;

      const pagesWalked = (state.pagesWalked ?? 0) + 1;
      const rowsSeen = (state.rowsSeen ?? 0) + rowsThisPage;

      if (pagesWalked >= maxPages || done) {
        // Move to the approval gate: park until an operator signals.
        return {
          op: 'wait',
          reason: 'Backfill pages walked; awaiting operator approval to finalize.',
          timeout_seconds: 3600,
          state: { phase: 'await_approval', pagesWalked, rowsSeen },
          label: `walked ${pagesWalked} pages, ${rowsSeen} rows`,
        };
      }
      // More pages to go: sleep to respect the provider rate limit, then continue.
      return {
        op: 'sleep',
        seconds: 5,
        state: { phase: 'backfill', pagesWalked, rowsSeen },
        label: `page ${pagesWalked} done`,
      };
    }

    if (phase === 'await_approval') {
      // Resumed by env.SPRIGR.jobs.signal(jobId, payload). The signal payload
      // decides whether we finish or abort.
      const approved = (job.signal?.payload as { approved?: boolean } | undefined)?.approved;
      if (approved === false) {
        return { op: 'fail', error: 'operator rejected the backfill', retryable: false };
      }
      return { op: 'continue', state: { ...state, phase: 'done' }, label: 'approved' };
    }

    // phase === 'done'
    return { op: 'complete', result: { pagesWalked: state.pagesWalked ?? 0, rowsSeen: state.rowsSeen ?? 0 } };
  } catch (err) {
    // A thrown error retries the STEP per the manifest retries policy; we
    // convert to an explicit retryable fail so the reason is legible.
    return { op: 'fail', error: err instanceof Error ? err.message : String(err), retryable: true };
  }
}

export default {
  showcase_backfill_step: (args: JobDispatch, env: ShowcaseEnv) => runBackfillStep(env, args),
};

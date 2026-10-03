/**
 * File change events on the platform event bus:
 * `<prefix>.file.created`, `<prefix>.file.updated`, `<prefix>.file.deleted`.
 *
 * Emission stays BEST-EFFORT per event (a failed emit is logged and the pass
 * goes on; the index is the source of truth), but it is no longer CAPPED.
 * Both apps used to emit the first 50 events of a run and drop the rest with
 * a warning while the cursor moved past them, so a workflow on file.* never
 * heard about the 51st change (sprigr-apps#2521). Now every event is emitted,
 * a few at a time, inside EMIT_BUDGET_MS; if that slice runs out, the events
 * not yet attempted are reported back by page so the indexer holds the cursor
 * at the first page it could not announce, and the next pass re-walks and
 * emits from there.
 *
 * A `file.deleted` claim (adapter.claimDeletedEvent) is taken right before its
 * emit and given back (releaseDeletedEvent) when the emit throws, so a
 * deletion is never latched without having been announced.
 */

import type { Deadline } from '@sprigr/apps-fetch-budget';
import { DEFAULT_FETCH_CONCURRENCY, deadlinePassed, mapWithConcurrency } from './tick-budget';
import type { FileIndexingEnv } from './types';

export interface FileEvent {
  name: string;
  payload: Record<string, unknown>;
  /** Index of the walk page the event came from (cursor-hold granularity). */
  page: number;
  /** For deletions: the objectID to claim before emitting. */
  claimObjectID?: string;
}

export interface EmitOutcome {
  emitted: number;
  failed: number;
  suppressed: number;
  /** Page of the first event NOT attempted because the slice ran out, or null. */
  firstUnattemptedPage: number | null;
}

export function fileEventNames(prefix: string): { created: string; updated: string; deleted: string } {
  return {
    created: `${prefix}.file.created`,
    updated: `${prefix}.file.updated`,
    deleted: `${prefix}.file.deleted`,
  };
}

/**
 * Emit events in page order, each page's events a few at a time, checking the
 * slice between pages. Never throws.
 */
export async function emitFileEvents(
  env: FileIndexingEnv,
  events: FileEvent[],
  opts: {
    deadline?: Deadline;
    now?: () => number;
    concurrency?: number;
    label?: string;
    claim?: (objectID: string) => Promise<boolean>;
    release?: (objectID: string) => Promise<void>;
  } = {},
): Promise<EmitOutcome> {
  const out: EmitOutcome = { emitted: 0, failed: 0, suppressed: 0, firstUnattemptedPage: null };
  if (events.length === 0) return out;
  const emit = env.SPRIGR?.emit;
  if (!emit) return out;
  const label = opts.label ?? '[file-indexing]';
  const now = opts.now ?? Date.now;
  const pages = [...new Set(events.map((e) => e.page))].sort((a, b) => a - b);
  for (const page of pages) {
    if (deadlinePassed(opts.deadline, now)) {
      out.firstUnattemptedPage = page;
      break;
    }
    const batch = events.filter((e) => e.page === page);
    await mapWithConcurrency(batch, opts.concurrency ?? DEFAULT_FETCH_CONCURRENCY, async (ev) => {
      if (ev.claimObjectID && opts.claim) {
        // Fail OPEN on a latch error: a missed notification is worse than a duplicate.
        const first = await opts.claim(ev.claimObjectID).catch(() => true);
        if (!first) {
          out.suppressed++;
          return;
        }
      }
      try {
        await emit(ev.name, ev.payload);
        out.emitted++;
      } catch (err) {
        out.failed++;
        console.warn(
          `${label} emit ${ev.name} failed (event skipped, sync unaffected):`,
          err instanceof Error ? err.message : String(err),
        );
        if (ev.claimObjectID && opts.release) await opts.release(ev.claimObjectID).catch(() => {});
      }
    });
  }
  if (out.firstUnattemptedPage !== null) {
    const left = events.filter((e) => e.page >= out.firstUnattemptedPage!).length;
    console.warn(
      `${label} event emission stopped at its budget with ${left} event(s) from page ${out.firstUnattemptedPage} on not yet emitted; the cursor holds there`,
    );
  }
  return out;
}

/**
 * The late row (sprigr-app-kit#267): a tick the dispatch wall is about to cut
 * never reaches its own timing row, so a timer writes one at a mark short of
 * the wall while the isolate is still alive. One copy of the timer for every
 * tick; the row's category, keys and writer stay with the app.
 */

import { callsForRow, type CallStat, type CallTiming } from './tick-timing';

export interface LateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: LateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LateWatch {
  /** The mark passed and the row write started. */
  readonly fired: boolean;
  /** The run finished: clear the timer. Safe to call more than once. */
  stop(): void;
  /** Resolves once a started row write is done. Never rejects. */
  settled(): Promise<void>;
}

export interface WatchLateOptions {
  /** Ms after `startedAt` to write the row; zero or less writes none. */
  lateAfterMs: number;
  /** Writes the row. Given the ms elapsed since `startedAt`. */
  onLate: (elapsedMs: number) => Promise<unknown>;
  now?: () => number;
  /** When the run began; defaults to now. */
  startedAt?: number;
  timers?: LateTimers;
  /** Keeps the row write alive past the response (`ctx.waitUntil`). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Prefix for the warning when the row write fails, e.g. `[dropbox-run]`. */
  label?: string;
}

export function watchLate(opts: WatchLateOptions): LateWatch {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const startedAt = opts.startedAt ?? now();
  const label = opts.label ?? '[tick-late]';
  let fired = false;
  let stopped = false;
  let write: Promise<void> | undefined;
  let handle: unknown;

  const fire = () => {
    // A clear can lose the race with a timer already queued.
    if (stopped || fired) return;
    fired = true;
    const elapsedMs = now() - startedAt;
    write = (async () => {
      try {
        await opts.onLate(elapsedMs);
      } catch (err) {
        console.warn(`${label} late row write failed after ${elapsedMs}ms:`, err instanceof Error ? err.message : err);
      }
    })();
    opts.waitUntil?.(write);
  };

  if (opts.lateAfterMs > 0) {
    handle = timers.set(fire, Math.max(0, opts.lateAfterMs - (now() - startedAt)));
  }

  return {
    get fired() {
      return fired;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== undefined) timers.clear(handle);
    },
    settled: () => write ?? Promise.resolve(),
  };
}

/** The timing half of a late row, under neutral names each app maps to its
 *  own keys: the slowest calls within `maxChars`, the calls still open, and
 *  each step's untimed ms. */
export function lateTimingFields(
  timing: CallTiming,
  maxChars = 1200,
): { calls: Record<string, CallStat | number>; open: Record<string, number>; untimed: Record<string, number> } {
  return { calls: callsForRow(timing.calls, maxChars), open: timing.open(), untimed: timing.untimed() };
}

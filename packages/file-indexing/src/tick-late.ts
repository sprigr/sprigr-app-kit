// Placeholder: today's bare late timer, as each app carries it.
import { callsForRow, type CallStat, type CallTiming } from './tick-timing';

export interface LateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export interface LateWatch {
  readonly fired: boolean;
  stop(): void;
  settled(): Promise<void>;
}
export interface WatchLateOptions {
  lateAfterMs: number;
  onLate: (elapsedMs: number) => Promise<unknown>;
  now?: () => number;
  startedAt?: number;
  timers?: LateTimers;
  waitUntil?: (p: Promise<unknown>) => void;
  label?: string;
}

export function watchLate(opts: WatchLateOptions): LateWatch {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let fired = false;
  let row: Promise<unknown> | undefined;
  const handle = opts.timers!.set(() => {
    fired = true;
    row = opts.onLate(now() - startedAt);
  }, opts.lateAfterMs);
  return {
    get fired() {
      return fired;
    },
    stop: () => opts.timers!.clear(handle),
    settled: async () => {
      await row;
    },
  };
}

export function lateTimingFields(timing: CallTiming): {
  calls: Record<string, CallStat | number>;
  open: Record<string, number>;
  untimed: Record<string, number>;
} {
  return { calls: callsForRow(timing.calls), open: timing.open(), untimed: timing.untimed() };
}

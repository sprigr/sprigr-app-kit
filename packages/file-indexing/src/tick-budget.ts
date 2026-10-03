/**
 * Wall-clock budgeting and bounded concurrency for scheduled indexing ticks.
 *
 * The platform dispatcher aborts a scheduled dispatch at 110 s
 * (`DISPATCH_WALL_MS` in @sprigr/apps-fetch-budget), and after consecutive
 * timeouts it auto-pauses the schedule with no time-based resume
 * (sprigr-team#3681). So every loop in a tick stops STARTING work once its
 * budget is spent, and never interrupts work already in flight: a cut always
 * lands on a boundary the caller has already made cursor-safe.
 *
 * One implementation, not three: the `Deadline` type and `createDeadline`
 * come from @sprigr/apps-fetch-budget, which the apps already use for their
 * per-attempt fetch caps. What is here is what that package does not cover:
 * TickBudget (a deadline that also reports elapsed time), mapWithConcurrency,
 * and deadline checks with an injectable clock, which the tests need and
 * fetch-budget's `budgetExhausted` (always Date.now) cannot take.
 */

import { createDeadline, type Deadline } from '@sprigr/apps-fetch-budget';

export { createDeadline };
export type { Deadline };

/** Wall-clock budget for one index-files tick: 60 s leaves ~50 s under the
 *  110 s dispatcher wall for the actor in flight to finish its page plus the
 *  terminal writes. The value both apps settled on (sprigr-team#6746,
 *  sprigr-apps#1513). */
export const INDEX_FILES_BUDGET_MS = 60_000;

/** The post-walk extraction drain's OWN slice (sprigr-team#8043). A separate
 *  slice bounds the drain without letting a budget-spending walk starve it. */
export const EXTRACTION_DRAIN_BUDGET_MS = 15_000;

/** The event-emission slice (sprigr-apps#2521). Its own slice for the same
 *  reason as the drain: emission runs after the walk, and a walk that spent
 *  the tick budget must not leave zero time to tell subscribers what it did.
 *  Events not emitted inside it hold the cursor at their page instead of
 *  being dropped. */
export const EMIT_BUDGET_MS = 15_000;

/** Least time that must remain before ONE more item is started. Starting with
 *  a few ms left just produces a near-zero abort that reads as a provider
 *  fault. */
export const MIN_ITEM_BUDGET_MS = 1_000;

/** Max concurrent per-item calls (permission reads, emits). */
export const DEFAULT_FETCH_CONCURRENCY = 6;

/** Milliseconds left; Infinity with no deadline. */
export function remainingBudgetMs(deadline: Deadline | undefined, now: () => number = Date.now): number {
  return deadline === undefined ? Infinity : deadline.at - now();
}

/** True when the deadline has passed and nothing new should be started. */
export function deadlinePassed(deadline: Deadline | undefined, now: () => number = Date.now): boolean {
  return remainingBudgetMs(deadline, now) <= 0;
}

/** True when less than `floorMs` remains. */
export function budgetBelow(floorMs: number, deadline: Deadline | undefined, now: () => number = Date.now): boolean {
  return remainingBudgetMs(deadline, now) < floorMs;
}

/** A monotonic wall-clock budget. `expired()` is true once `budgetMs` has
 *  elapsed since construction; `deadline()` hands the same expiry to a
 *  fetch-budget call so one number bounds both. */
export class TickBudget {
  private readonly start: number;
  private readonly budgetMs: number;
  private readonly now: () => number;
  constructor(budgetMs: number, now: () => number = Date.now) {
    this.now = now;
    this.start = now();
    this.budgetMs = budgetMs;
  }
  elapsedMs(): number {
    return this.now() - this.start;
  }
  expired(): boolean {
    return this.elapsedMs() >= this.budgetMs;
  }
  deadline(): Deadline {
    return { at: this.start + this.budgetMs };
  }
}

/**
 * Map `items` through `fn` with at most `concurrency` in flight, preserving
 * input order. The FIRST rejection propagates; calls already started settle
 * but their results are discarded (sequential fail-fast semantics).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

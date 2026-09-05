/**
 * @sprigr/apps-fetch-budget
 *
 * Two clocks for outbound HTTP from a marketplace app, under the
 * platform dispatcher's 110-second wall: a per-attempt cap, and a call
 * budget (deadline) shared by every attempt, retry and throttle sleep.
 *
 *   const deadline = createDeadline(25_000);            // once per invocation
 *   while (!budgetExhausted(deadline, 2_000)) {
 *     const resp = await fetchWithBudget(url, init, deadline, { attemptCapMs: 15_000 });
 *     ...
 *   }
 *
 * See `fetch-budget.ts` for the budget arithmetic and the failure modes.
 */

export {
  createDeadline,
  remainingMs,
  budgetExhausted,
  attemptTimeoutMs,
  fetchWithBudget,
  budgetSignal,
  isAbortLike,
  isFetchBudgetTimeout,
  FetchBudgetTimeoutError,
  DISPATCH_WALL_MS,
  DEFAULT_ATTEMPT_CAP_MS,
} from './fetch-budget';
export type { Deadline, FetchBudgetPhase, FetchWithBudgetOptions } from './fetch-budget';

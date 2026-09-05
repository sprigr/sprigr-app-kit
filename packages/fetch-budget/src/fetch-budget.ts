/**
 * Bounded outbound HTTP for marketplace apps.
 *
 * `fetch()` in workerd has NO default timeout. A provider request that
 * never answers hangs until something above kills the whole invocation,
 * and for a marketplace tool or schedule that something is the platform
 * dispatcher: it aborts at 110s and reports
 * `timeout: dispatch exceeded 110000ms`, naming neither the app nor the
 * call that hung. Every diagnosis then starts from zero.
 *
 * Two clocks, and apps need both:
 *
 *   - a PER-ATTEMPT cap sizes one outbound request, so a single stalled
 *     connection cannot consume the invocation;
 *   - a CALL BUDGET (a deadline, computed once at invocation start) is
 *     shared by every attempt, every retry and every throttle sleep, so
 *     N bounded legs cannot add up past the dispatch wall.
 *
 * A cap alone is not a budget: three legs under a 25s cap is 75s, and a
 * pre-check ("is there time left?") is not a bound either, because the
 * leg it admits is then awaited with nothing capping it. That is exactly
 * how sprigr-team#7205 overran an 18s self-imposed budget by more than
 * 6x. The deadline here is enforced twice: `budgetExhausted` refuses to
 * start new work, and `attemptTimeoutMs` clamps each attempt to what is
 * left, so a leg that starts just under the deadline aborts AT the
 * deadline rather than a full cap past it.
 *
 * This package exists because five apps wrote the same helper five
 * times (shopify, simpro, microsoft-365, google-workspace, xero) and an
 * app cannot import another app's lib. `@sprigr/apps-app-sdk`'s
 * `fetchWithRetry` retries and backs off but takes no timeout and passes
 * no signal, which is why each of them rolled its own.
 */

/**
 * The platform dispatcher's hard wall for one install dispatch
 * (`DISPATCH_TIMEOUT_MS` in sprigr-team's install-dispatch). Exported so
 * an app's budget arithmetic can name the number it is sizing against
 * rather than restating 110000 in a comment. Never pass this as a call
 * budget: leave room for the work either side of the network legs.
 */
export const DISPATCH_WALL_MS = 110_000;

/**
 * Default per-attempt cap when a caller supplies none. Deliberately far
 * below the dispatch wall so a stalled request fails as the app's own
 * named error, with time left to report it.
 */
export const DEFAULT_ATTEMPT_CAP_MS = 15_000;

/**
 * An absolute cap for one logical call or invocation, computed ONCE and
 * then passed down. It is an object rather than a bare epoch number so a
 * signature cannot silently accept a duration where it wanted a deadline
 * (the two are both `number` and the mix-up is invisible at the call
 * site).
 */
export interface Deadline {
  /** Absolute epoch-ms after which nothing new may start. */
  readonly at: number;
}

/** Which clock cut the request short. */
export type FetchBudgetPhase =
  /** The per-attempt cap fired; the shared budget still had time left. */
  | 'attempt'
  /** The shared call budget ran out; retrying inside this invocation is pointless. */
  | 'budget';

/** Query strings can carry ids, tokens and signed URLs; the path alone names the call. */
function withoutQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url ?? String(input);
}

/**
 * A request that produced no response inside its budget.
 *
 * Distinct from an app's own API error type (which always carries a real
 * HTTP status and body) so callers can tell "the provider said no" from
 * "the provider said nothing". `retryable` is true because a hung
 * connection carries no information about the request itself: the same
 * call may well succeed on the next tick, and no write is known to have
 * landed. `phase` says whether it is worth retrying HERE: an `attempt`
 * timeout may have budget left, a `budget` timeout does not.
 */
export class FetchBudgetTimeoutError extends Error {
  readonly retryable = true;
  constructor(
    /** The request URL, query string stripped. */
    public readonly url: string,
    /** The cap that fired, in ms. */
    public readonly timeoutMs: number,
    public readonly phase: FetchBudgetPhase,
  ) {
    super(`fetch_budget_timeout: ${phase} cap of ${timeoutMs}ms elapsed for ${withoutQuery(url)}`);
    this.name = 'FetchBudgetTimeoutError';
  }
}

/** Narrow an unknown rejection to this package's timeout error. */
export function isFetchBudgetTimeout(err: unknown): err is FetchBudgetTimeoutError {
  return err instanceof FetchBudgetTimeoutError;
}

/**
 * True when a fetch rejection came from an abort rather than the network.
 * `AbortSignal.timeout` rejects with a DOMException named 'TimeoutError';
 * a controller-driven abort surfaces 'AbortError'. Matched by NAME, not
 * by `instanceof DOMException`, so a test double or a polyfilled runtime
 * that throws a plain Error is still recognised.
 */
export function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Start a budget of `totalMs` from now. Call this ONCE per invocation
 * (or per logical client call) and thread the result through every leg;
 * a deadline recomputed per leg is a pre-check, not a budget.
 */
export function createDeadline(totalMs: number, now: number = Date.now()): Deadline {
  return { at: now + Math.max(0, totalMs) };
}

/**
 * Milliseconds left on the deadline. `Infinity` when there is none, so
 * an unbudgeted caller (a single interactive tool call, say) can pass
 * `undefined` through the same code path.
 */
export function remainingMs(deadline?: Deadline): number {
  return deadline === undefined ? Infinity : deadline.at - Date.now();
}

/**
 * True when there is not enough budget left to be worth starting new
 * work. `minMs` is the floor a caller needs to make progress: pass the
 * smallest useful leg (a token refresh, one page) rather than 0 if
 * starting one that immediately aborts is worse than skipping it.
 */
export function budgetExhausted(deadline?: Deadline, minMs = 0): boolean {
  return remainingMs(deadline) <= minMs;
}

/**
 * How long this attempt may run: `min(cap, time left on the deadline)`.
 * Never negative, so a caller already past the deadline gets 0 and
 * aborts immediately instead of waiting a full cap.
 */
export function attemptTimeoutMs(deadline: Deadline | undefined, capMs: number): number {
  const cap = Math.max(0, capMs);
  if (deadline === undefined) return cap;
  return Math.max(0, Math.min(cap, deadline.at - Date.now()));
}

/**
 * Compose two signals. Prefers the platform `AbortSignal.any`; the
 * manual fallback covers a runtime that predates it (Node < 20.3).
 */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, [a, b]);
  const controller = new AbortController();
  const forward = (s: AbortSignal) => {
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  };
  forward(a);
  forward(b);
  return controller.signal;
}

export interface FetchWithBudgetOptions {
  /** Per-attempt cap in ms. Defaults to {@link DEFAULT_ATTEMPT_CAP_MS}. */
  attemptCapMs?: number;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Injected for
   * tests, and for a caller that wraps fetch (tracing, a mock provider).
   */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * `fetch` bounded by both clocks.
 *
 * - Refuses to open a request at all once the deadline has passed, and
 *   throws `phase: 'budget'` without touching the network.
 * - Otherwise aborts at `min(attemptCapMs, time left)` and throws
 *   `FetchBudgetTimeoutError`; `phase` is `'budget'` when the deadline
 *   is what clamped the attempt, `'attempt'` when the cap is.
 * - Composes (never replaces) `init.signal`, so a caller's own
 *   cancellation still works. A rejection caused by THAT signal is
 *   rethrown untouched: the caller cancelled, the budget did not expire.
 * - Every other rejection (network error, bad URL) is rethrown untouched.
 *
 * The timeout is enforced by racing an internal timer against the fetch,
 * as well as aborting the request. A `fetch` that honours the signal is
 * cancelled properly; one that ignores it still cannot outlive the
 * budget.
 */
export async function fetchWithBudget(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deadline?: Deadline,
  opts: FetchWithBudgetOptions = {},
): Promise<Response> {
  const url = urlOf(input);
  const capMs = opts.attemptCapMs ?? DEFAULT_ATTEMPT_CAP_MS;

  if (budgetExhausted(deadline)) {
    // Opening a request we know cannot finish burns a connection and
    // hides the real cause behind a network-looking abort.
    throw new FetchBudgetTimeoutError(url, 0, 'budget');
  }

  const timeoutMs = attemptTimeoutMs(deadline, capMs);
  // The deadline is what bounded this attempt whenever it clamped the
  // cap, so retrying inside this invocation would only re-abort sooner.
  const phase: FetchBudgetPhase = deadline !== undefined && timeoutMs < capMs ? 'budget' : 'attempt';

  const doFetch = opts.fetchImpl ?? ((i: RequestInfo | URL, ini?: RequestInit) => fetch(i, ini));
  const callerSignal = init?.signal ?? undefined;
  const controller = new AbortController();
  const signal = callerSignal ? anySignal(callerSignal, controller.signal) : controller.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetCut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new FetchBudgetTimeoutError(url, timeoutMs, phase);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([doFetch(input, { ...init, signal }), budgetCut]);
  } catch (err) {
    if (isFetchBudgetTimeout(err)) throw err;
    // The caller's own cancellation is theirs to interpret.
    if (callerSignal?.aborted) throw err;
    if (isAbortLike(err)) throw new FetchBudgetTimeoutError(url, timeoutMs, phase);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The bounded signal on its own, for a caller that must keep its own
 * `fetch` call (streaming a response body, a client that builds `init`
 * elsewhere). Same clamping as {@link fetchWithBudget}, but the caller
 * owns the error mapping: a fired signal rejects `fetch` with a
 * DOMException, so pair it with {@link isAbortLike}.
 */
export function budgetSignal(
  deadline: Deadline | undefined,
  capMs: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs(deadline, capMs));
  return callerSignal ? anySignal(callerSignal, timeoutSignal) : timeoutSignal;
}

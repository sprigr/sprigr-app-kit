/**
 * fetchWithRetry — rate-limit-header-aware retry wrapper around fetch.
 *
 * Retries on:
 *   - 429 Too Many Requests, for every method, since the server did not
 *     process the request. Honors `Retry-After` (seconds) and
 *     `X-RateLimit-Reset` (epoch seconds) when present, else
 *     exponential-backoff with jitter.
 *   - 5xx and errors thrown by fetch, only for an idempotent request
 *     (see `idempotent` below). Either can follow a write the server
 *     already committed, so a POST answered 502 is returned, not sent
 *     again (sprigr-app-kit#83). Exponential backoff.
 *
 * Does NOT retry: 4xx other than 429 (caller's bug), redirects, 401
 * (auth — caller decides whether to refresh + retry), or an abort or
 * timeout from the caller's signal. A signal that fires during a backoff
 * ends the call with its reason; no further attempt is made.
 *
 * A response dropped for a retry has its body cancelled.
 */

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  /** Base backoff in ms; doubled each attempt and jittered ±30%. */
  baseBackoffMs?: number;
  /** Hard cap on total wait across all retries (ms). */
  maxTotalWaitMs?: number;
  /**
   * Whether the request is safe to send again after a 5xx or a thrown
   * network error. Default: true for GET, HEAD, OPTIONS, PUT and DELETE
   * (idempotent by RFC 9110), and for any request carrying a non-empty
   * `Idempotency-Key` or `Idempotency-Token` header; false for POST and
   * PATCH otherwise. Pass true for a read sent as POST (GraphQL, search);
   * pass false for a PUT or DELETE the provider does not treat as
   * idempotent, or to keep any request to one attempt. A 429 is retried
   * either way.
   */
  idempotent?: boolean;
  /** Called with each attempt's failure metadata; useful for logging. */
  onRetry?: (info: { attempt: number; status: number | null; waitMs: number; reason: string }) => void;
  /**
   * Absolute deadline in epoch ms (sprigr-app-kit#309). No attempt starts and
   * no retry wait sleeps past it; the call then throws FetchDeadlineError. The
   * returned response stays bound to it, so its body read is bounded too.
   */
  deadlineMs?: number;
}

/** Thrown when `deadlineMs` ends the call (sprigr-app-kit#309). */
export class FetchDeadlineError extends Error {
  override name = 'FetchDeadlineError';
  constructor(
    readonly deadlineMs: number,
    readonly attempts: number,
    /** Status of the last response received, else null. */
    readonly lastStatus: number | null,
    /** The retry wait that did not fit before the deadline, else null. */
    readonly waitMs: number | null,
    options?: { cause?: unknown },
  ) {
    super(`fetch deadline reached after ${attempts} attempt(s)`, options);
  }
}

/** True for a FetchDeadlineError, checked by name so two bundled copies of app-sdk still match. */
export function isFetchDeadlineError(err: unknown): err is FetchDeadlineError {
  return (err as { name?: unknown } | null)?.name === 'FetchDeadlineError';
}

const DEFAULT_OPTS: Required<Pick<FetchWithRetryOptions, 'maxAttempts' | 'baseBackoffMs' | 'maxTotalWaitMs'>> = {
  maxAttempts: 4,
  baseBackoffMs: 500,
  maxTotalWaitMs: 30_000,
};

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const deadline = opts.deadlineMs;
  if (deadline !== undefined) assertDeadline(deadline);
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  // With a deadline, fetch gets this call's own signal, which would drop the
  // Request's signal beside init.signal; follow both, first reason wins.
  const signal = deadline === undefined
    ? init?.signal ?? request?.signal ?? null
    : firstToAbort(init?.signal ?? null, request?.signal ?? null);
  const idempotent = opts.idempotent ?? isIdempotentRequest(init, request);
  let totalWait = 0;
  let lastError: unknown = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new FetchDeadlineError(deadline, attempt - 1, lastStatus, null);
    }
    const bound = deadline === undefined
      ? null
      : boundAttempt(deadline, signal, () => new FetchDeadlineError(deadline, attempt, lastStatus, null));
    let resp: Response;
    try {
      resp = await fetch(input, bound ? { ...init, signal: bound.signal } : init);
    } catch (err) {
      bound?.release();
      lastError = err;
      if (bound) {
        // The caller's reason wins even when the deadline fired in the same tick.
        if (signal?.aborted) throw signal.reason;
        if (bound.fired()) throw new FetchDeadlineError(deadline!, attempt, lastStatus, null);
      }
      // Thrown after the request may have been sent: only an idempotent
      // request goes again, and never one the caller's signal stopped.
      if (!idempotent || isAbort(err, signal) || attempt === cfg.maxAttempts) throw err;
      const wait = expBackoff(attempt, cfg.baseBackoffMs);
      if (deadline !== undefined && Date.now() + wait >= deadline) {
        throw new FetchDeadlineError(deadline, attempt, lastStatus, wait, { cause: err });
      }
      if (totalWait + wait > cfg.maxTotalWaitMs) throw err;
      opts.onRetry?.({ attempt, status: null, waitMs: wait, reason: 'network_error' });
      await sleep(wait, signal);
      totalWait += wait;
      continue;
    }
    lastStatus = resp.status;
    const retryable = resp.status === 429 || (resp.status >= 500 && idempotent);
    // A returned response keeps its deadline armed, so its body read is bounded too.
    if (!retryable || attempt === cfg.maxAttempts) return resp;
    const wait = waitForResponse(resp, attempt, cfg);
    if (deadline !== undefined && Date.now() + wait >= deadline) {
      bound?.release();
      await discardBody(resp);
      throw new FetchDeadlineError(deadline, attempt, resp.status, wait);
    }
    if (totalWait + wait > cfg.maxTotalWaitMs) return resp;
    bound?.release();
    opts.onRetry?.({ attempt, status: resp.status, waitMs: wait, reason: resp.status === 429 ? 'rate_limited' : 'server_error' });
    await discardBody(resp);
    await sleep(wait, signal);
    totalWait += wait;
  }

  // Should not reach here, but type narrowing.
  throw lastError ?? new Error('fetchWithRetry exhausted');
}

/** Epoch ms of 1973-03-03: anything smaller is a duration passed by mistake. */
const MIN_EPOCH_DEADLINE_MS = 1e11;

function assertDeadline(deadline: number): void {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) {
    throw new TypeError('deadlineMs must be a finite epoch time in ms');
  }
  if (deadline < MIN_EPOCH_DEADLINE_MS) {
    throw new TypeError('deadlineMs is an absolute epoch time in ms, not a duration');
  }
}

/** One signal that aborts with the reason of whichever of `a` and `b` aborts first. */
function firstToAbort(a: AbortSignal | null, b: AbortSignal | null): AbortSignal | null {
  if (!a || !b || a === b) return a ?? b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onA = () => { b.removeEventListener('abort', onB); controller.abort(a.reason); };
  const onB = () => { a.removeEventListener('abort', onA); controller.abort(b.reason); };
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return controller.signal;
}

/**
 * One attempt's signal: aborted at the deadline, or with the caller's reason
 * when the caller's signal fires. `release` drops both once the attempt's
 * response is not handed back.
 */
function boundAttempt(deadline: number, caller: AbortSignal | null, reason: () => FetchDeadlineError) {
  const controller = new AbortController();
  let fired = false;
  const onCaller = () => controller.abort(caller!.reason);
  if (caller?.aborted) controller.abort(caller.reason);
  else caller?.addEventListener('abort', onCaller, { once: true });
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(reason());
  }, Math.max(0, deadline - Date.now()));
  return {
    signal: controller.signal,
    fired: () => fired,
    release: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCaller);
    },
  };
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const IDEMPOTENCY_HEADERS = ['idempotency-key', 'idempotency-token'];

function isIdempotentRequest(init: RequestInit | undefined, request: Request | null): boolean {
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (IDEMPOTENT_METHODS.has(method)) return true;
  const headers = new Headers(init?.headers ?? request?.headers);
  return IDEMPOTENCY_HEADERS.some((name) => (headers.get(name) ?? '').trim() !== '');
}

function isAbort(err: unknown, signal: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Free the connection a dropped response holds. A body already locked or errored has nothing to free. */
async function discardBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // nothing to free
  }
}

function waitForResponse(resp: Response, attempt: number, cfg: { baseBackoffMs: number }): number {
  const retryAfter = resp.headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  // Procore-specific: X-RateLimit-Reset is epoch seconds when next bucket opens.
  const reset = resp.headers.get('x-ratelimit-reset');
  if (reset) {
    const resetEpoch = parseInt(reset, 10);
    if (!Number.isNaN(resetEpoch)) {
      const waitMs = resetEpoch * 1000 - Date.now();
      if (waitMs > 0 && waitMs < 60_000) return waitMs;
    }
  }
  return expBackoff(attempt, cfg.baseBackoffMs);
}

function expBackoff(attempt: number, base: number): number {
  const expo = base * Math.pow(2, attempt - 1);
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.floor(expo * jitter);
}

/** Wait `ms`, or reject with the signal's reason as soon as it fires. */
function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

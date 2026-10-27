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
   * network error. Default: true for GET, HEAD and OPTIONS, and for any
   * request carrying a non-empty `Idempotency-Key` or `Idempotency-Token`
   * header; false otherwise. Pass true for a read sent as POST (GraphQL,
   * search) or a PUT/DELETE the provider treats as idempotent; pass false
   * to keep a GET to one attempt. A 429 is retried either way.
   */
  idempotent?: boolean;
  /** Called with each attempt's failure metadata; useful for logging. */
  onRetry?: (info: { attempt: number; status: number | null; waitMs: number; reason: string }) => void;
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
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const signal = init?.signal ?? request?.signal ?? null;
  const idempotent = opts.idempotent ?? isIdempotentRequest(init, request);
  let totalWait = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(input, init);
    } catch (err) {
      lastError = err;
      // Thrown after the request may have been sent: only an idempotent
      // request goes again, and never one the caller's signal stopped.
      if (!idempotent || isAbort(err, signal) || attempt === cfg.maxAttempts) throw err;
      const wait = expBackoff(attempt, cfg.baseBackoffMs);
      if (totalWait + wait > cfg.maxTotalWaitMs) throw err;
      opts.onRetry?.({ attempt, status: null, waitMs: wait, reason: 'network_error' });
      await sleep(wait, signal);
      totalWait += wait;
      continue;
    }
    const retryable = resp.status === 429 || (resp.status >= 500 && idempotent);
    if (!retryable || attempt === cfg.maxAttempts) return resp;
    const wait = waitForResponse(resp, attempt, cfg);
    if (totalWait + wait > cfg.maxTotalWaitMs) return resp;
    opts.onRetry?.({ attempt, status: resp.status, waitMs: wait, reason: resp.status === 429 ? 'rate_limited' : 'server_error' });
    await discardBody(resp);
    await sleep(wait, signal);
    totalWait += wait;
  }

  // Should not reach here, but type narrowing.
  throw lastError ?? new Error('fetchWithRetry exhausted');
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
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

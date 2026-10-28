/**
 * fetchWithRetry — rate-limit-header-aware retry wrapper around fetch.
 *
 * Retries on:
 *   - 429 Too Many Requests, any method: honors `Retry-After` (seconds) and
 *     `X-RateLimit-Reset` (epoch seconds) when present, else
 *     exponential-backoff with jitter.
 *   - 5xx and thrown network errors, idempotent requests only: GET, HEAD,
 *     OPTIONS, PUT, a request carrying an `Idempotency-Key` or
 *     `Idempotency-Token` header, or `retryNonIdempotent: true` (which is
 *     also how a DELETE opts in). A POST or PATCH that got a 5xx may already
 *     have been applied upstream, so it is returned, not resent.
 *
 * Does NOT retry: 4xx other than 429 (caller's bug), redirects, 401
 * (auth: caller decides whether to refresh + retry), or an abort or timeout
 * from the caller's own signal.
 */

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  /** Base backoff in ms; doubled each attempt and jittered ±30%. */
  baseBackoffMs?: number;
  /** Hard cap on total wait across all retries (ms). */
  maxTotalWaitMs?: number;
  /** Called with each attempt's failure metadata; useful for logging. */
  onRetry?: (info: { attempt: number; status: number | null; waitMs: number; reason: string }) => void;
  /**
   * Resend after a 5xx or a network error even though the method is not
   * idempotent (the provider dedupes it some other way).
   */
  retryNonIdempotent?: boolean;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT']);

function isIdempotentRequest(input: RequestInfo | URL, init: RequestInit | undefined, explicit: boolean): boolean {
  if (explicit) return true;
  const req = input instanceof Request ? input : null;
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? req?.headers);
  if (headers.has('idempotency-key') || headers.has('idempotency-token')) return true;
  return IDEMPOTENT_METHODS.has(method);
}

function isAbort(err: unknown, init: RequestInit | undefined): boolean {
  if (init?.signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
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
  const idempotent = isIdempotentRequest(input, init, opts.retryNonIdempotent === true);
  let totalWait = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (resp.status === 429 || (resp.status >= 500 && idempotent)) {
        if (attempt === cfg.maxAttempts) return resp;
        const wait = waitForResponse(resp, attempt, cfg);
        if (totalWait + wait > cfg.maxTotalWaitMs) return resp;
        opts.onRetry?.({ attempt, status: resp.status, waitMs: wait, reason: resp.status === 429 ? 'rate_limited' : 'server_error' });
        await resp.body?.cancel().catch(() => undefined);
        await sleep(wait);
        totalWait += wait;
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err;
      if (!idempotent || isAbort(err, init) || attempt === cfg.maxAttempts) throw err;
      const wait = expBackoff(attempt, cfg.baseBackoffMs);
      if (totalWait + wait > cfg.maxTotalWaitMs) throw err;
      opts.onRetry?.({ attempt, status: null, waitMs: wait, reason: 'network_error' });
      await sleep(wait);
      totalWait += wait;
    }
  }

  // Should not reach here, but type narrowing.
  throw lastError ?? new Error('fetchWithRetry exhausted');
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetchWithRetry — rate-limit-header-aware retry wrapper around fetch.
 *
 * Retries on:
 *   - 429 Too Many Requests — honors `Retry-After` (seconds) and
 *     `X-RateLimit-Reset` (epoch seconds) when present, else
 *     exponential-backoff with jitter.
 *   - 5xx — exponential backoff.
 *   - Network errors (TypeError thrown by fetch) — exponential backoff.
 *
 * Does NOT retry: 4xx other than 429 (caller's bug), redirects, 401
 * (auth — caller decides whether to refresh + retry).
 */

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  /** Base backoff in ms; doubled each attempt and jittered ±30%. */
  baseBackoffMs?: number;
  /** Hard cap on total wait across all retries (ms). */
  maxTotalWaitMs?: number;
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
  let totalWait = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt === cfg.maxAttempts) return resp;
        const wait = waitForResponse(resp, attempt, cfg);
        if (totalWait + wait > cfg.maxTotalWaitMs) return resp;
        opts.onRetry?.({ attempt, status: resp.status, waitMs: wait, reason: resp.status === 429 ? 'rate_limited' : 'server_error' });
        await sleep(wait);
        totalWait += wait;
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err;
      if (attempt === cfg.maxAttempts) throw err;
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

/**
 * invokeWithBusyRetry: retry env.SPRIGR.invoke only while the platform's
 * daily registry D1 export refuses it (sprigr-app-kit#156).
 *
 * During the export the platform answers 503 `platform_d1_export_busy`
 * before dispatching anything, so a retry cannot repeat a write. Every other
 * failure (`target_timeout`, `target_invoke_failed`, any other 5xx) can follow
 * a real dispatch and is rethrown unchanged.
 *
 * Call it from a job loop with its own budget (a scheduled run, a webhook
 * batch), not to stretch one call: the export lasts 75-200 s and a single
 * invoke hop is capped at 25 s.
 */

export const PLATFORM_D1_EXPORT_BUSY_CODE = 'platform_d1_export_busy';

export interface SprigrInvokeEnv {
  SPRIGR: { invoke(toolName: string, args?: unknown): Promise<unknown> };
}

export interface InvokeWithBusyRetryOptions {
  /** Total attempts, first call included. Default 4, enough to span a 200 s export. */
  maxAttempts?: number;
  /** Epoch ms the caller must finish by. No retry starts whose wait would cross it. */
  deadlineAt?: number;
  /** Wait when the error carries no retry-after. Default 30 s, the platform's Retry-After. */
  defaultRetryAfterSec?: number;
  onRetry?: (info: { attempt: number; waitMs: number }) => void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** True for the platform's "registry export in progress, nothing was sent" refusal. */
export function isPlatformBusyError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return !!e && e.status === 503 && e.code === PLATFORM_D1_EXPORT_BUSY_CODE;
}

function retryAfterMs(err: unknown, defaultSec: number): number {
  const raw = (err as { retryAfter?: unknown }).retryAfter;
  const sec = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : defaultSec;
  return Math.round(sec * 1000);
}

export async function invokeWithBusyRetry<T = unknown>(
  env: SprigrInvokeEnv,
  toolName: string,
  args?: unknown,
  opts: InvokeWithBusyRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const defaultSec = opts.defaultRetryAfterSec ?? 30;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return (await env.SPRIGR.invoke(toolName, args)) as T;
    } catch (err) {
      if (!isPlatformBusyError(err) || attempt >= maxAttempts) throw err;
      const waitMs = retryAfterMs(err, defaultSec);
      if (opts.deadlineAt !== undefined && now() + waitMs >= opts.deadlineAt) throw err;
      opts.onRetry?.({ attempt, waitMs });
      await sleep(waitMs);
    }
  }
}

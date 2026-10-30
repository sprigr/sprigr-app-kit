import { describe, expect, it, vi } from 'vitest';
import { invokeWithBusyRetry, isPlatformBusyError } from '../src/invoke-retry';

const busy = () => Object.assign(new Error('env.SPRIGR.invoke(x) failed: 503 platform_d1_export_busy'), { status: 503, code: 'platform_d1_export_busy' });
const failure = (status: number, code: string) => Object.assign(new Error(`failed: ${status} ${code}`), { status, code });

function envFrom(...outcomes: Array<unknown>) {
  const invoke = vi.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { env: { SPRIGR: { invoke } }, invoke };
}

describe('invokeWithBusyRetry (#156)', () => {
  it('retries through the export window and returns the result, waiting 30 s each time', async () => {
    const { env, invoke } = envFrom(busy(), busy(), { ok: true });
    const sleep = vi.fn(async () => {});
    await expect(invokeWithBusyRetry(env, 'google_ads_search_stream', { q: 1 }, { sleep })).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledWith('google_ads_search_stream', { q: 1 });
    expect(sleep.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it.each([
    ['a timeout after dispatch', failure(504, 'target_timeout')],
    ['a failed target', failure(502, 'target_invoke_failed')],
    ['a 503 with another code', failure(503, 'something_else')],
  ])('never retries %s: it may already have written', async (_label, err) => {
    const { env, invoke } = envFrom(err);
    const sleep = vi.fn(async () => {});
    await expect(invokeWithBusyRetry(env, 't', {}, { sleep })).rejects.toBe(err);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxAttempts and rethrows the busy error', async () => {
    const last = busy();
    const { env, invoke } = envFrom(busy(), busy(), busy(), last);
    await expect(invokeWithBusyRetry(env, 't', {}, { sleep: async () => {} })).rejects.toBe(last);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("does not start a wait that would cross the caller's deadline", async () => {
    const first = busy();
    const { env, invoke } = envFrom(first, { ok: true });
    const sleep = vi.fn(async () => {});
    await expect(invokeWithBusyRetry(env, 't', {}, { sleep, now: () => 1_000, deadlineAt: 20_000 })).rejects.toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours a retryAfter the error carries', async () => {
    const err = Object.assign(busy(), { retryAfter: 5 });
    const { env } = envFrom(err, 'done');
    const sleep = vi.fn(async () => {});
    await invokeWithBusyRetry(env, 't', {}, { sleep });
    expect(sleep.mock.calls).toEqual([[5_000]]);
  });

  it('recognises only the platform busy refusal', () => {
    expect(isPlatformBusyError(busy())).toBe(true);
    expect(isPlatformBusyError(failure(503, 'target_timeout'))).toBe(false);
    expect(isPlatformBusyError(null)).toBe(false);
  });
});

/**
 * fetchWithRetry's `deadlineMs` bounds a call that is already in flight
 * (sprigr-app-kit#309). A paged walker checks its time budget between pages,
 * but only the deadline stops a slow attempt, a retry or a Retry-After wait
 * from running past the platform's dispatch limit, and the typed error lets
 * the walker report what it read instead of being cut off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, isFetchDeadlineError, type FetchDeadlineError } from '../src/fetch';

const T0 = 1_800_000_000_000;
const URL_ = 'https://api.example.test/things';

type Step = number | Error | Response | ((init?: RequestInit) => Promise<Response>);

/** A fetch that answers each call with the next step. */
function scripted(...steps: Step[]) {
  let n = 0;
  const fn = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const step = steps[Math.min(n++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step;
    if (typeof step === 'function') return step(init);
    return new Response(`body ${step}`, { status: step });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Settles only when the signal fetch was given aborts; never without one. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function track<T>(p: Promise<T>) {
  const s: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (v) => { s.settled = true; s.value = v; },
    (e) => { s.settled = true; s.error = e; },
  );
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  // Jitter factor 1.0, so a backoff is exactly base * 2^(attempt - 1).
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchWithRetry deadlineMs (#309)', () => {
  it('1. aborts a slow attempt at the deadline with FetchDeadlineError', async () => {
    const fn = scripted(hangUntilAborted);
    const call = track(fetchWithRetry(URL_, undefined, { deadlineMs: T0 + 1000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(isFetchDeadlineError(call.error)).toBe(true);
    const err = call.error as FetchDeadlineError;
    expect(err.name).toBe('FetchDeadlineError');
    expect(err.deadlineMs).toBe(T0 + 1000);
    expect(err.attempts).toBe(1);
    expect(err.lastStatus).toBeNull();
    expect(err.waitMs).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('2. stops a retry after a 5xx at the deadline, keeping the 5xx status', async () => {
    const fn = scripted(503, hangUntilAborted);
    const call = track(fetchWithRetry(URL_, undefined, { baseBackoffMs: 500, deadlineMs: T0 + 3000 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(call.settled).toBe(true);
    expect(isFetchDeadlineError(call.error)).toBe(true);
    const err = call.error as FetchDeadlineError;
    expect(err.lastStatus).toBe(503);
    expect(err.attempts).toBe(2);
    expect(err.waitMs).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('3. throws at once on a 429 whose Retry-After is longer than the time left', async () => {
    const fn = scripted(new Response('slow down', { status: 429, headers: { 'Retry-After': '10' } }), 200);
    const call = track(fetchWithRetry(URL_, undefined, { deadlineMs: T0 + 5000 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(isFetchDeadlineError(call.error)).toBe(true);
    const err = call.error as FetchDeadlineError;
    expect(err.lastStatus).toBe(429);
    expect(err.waitMs).toBe(10_000);
    expect(err.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('4. throws at once when a network-error backoff would cross the deadline, keeping the cause', async () => {
    const netErr = new TypeError('fetch failed');
    const fn = scripted(netErr, 200);
    // Default base backoff: 500 ms for the first retry, more than the 300 ms left.
    const call = track(fetchWithRetry(URL_, { method: 'GET' }, { deadlineMs: T0 + 300 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(isFetchDeadlineError(call.error)).toBe(true);
    const err = call.error as FetchDeadlineError;
    expect(err.cause).toBe(netErr);
    expect(err.lastStatus).toBeNull();
    expect(err.waitMs).toBe(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('5. makes no request when the deadline has already passed', async () => {
    const fn = scripted(200);
    const call = track(fetchWithRetry(URL_, undefined, { deadlineMs: T0 - 1 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(0);
    expect(isFetchDeadlineError(call.error)).toBe(true);
    expect((call.error as FetchDeadlineError).attempts).toBe(0);
  });

  it('6. keeps the returned response bounded: its signal aborts at the deadline', async () => {
    const fn = scripted(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('ok', { status: 200 })), 100)),
    );
    const call = track(fetchWithRetry(URL_, undefined, { deadlineMs: T0 + 1000 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(call.settled).toBe(true);
    expect(call.value?.status).toBe(200);
    const signal = fn.mock.calls[0]![1]?.signal;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(signal!.aborted).toBe(true);
    expect(isFetchDeadlineError(signal!.reason)).toBe(true);
  });

  it('7. refuses a deadline that is not a finite number', async () => {
    const fn = scripted(200);
    await expect(fetchWithRetry(URL_, undefined, { deadlineMs: Number.NaN })).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('8. refuses a duration passed as deadlineMs', async () => {
    const fn = scripted(200);
    await expect(fetchWithRetry(URL_, undefined, { deadlineMs: 20_000 })).rejects.toThrow(
      new TypeError('deadlineMs is an absolute epoch time in ms, not a duration'),
    );
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('9. lets a deadline that maxTotalWaitMs would also stop throw, rather than return the 429', async () => {
    const fn = scripted(new Response('slow down', { status: 429, headers: { 'Retry-After': '10' } }), 200);
    const call = track(fetchWithRetry(URL_, undefined, { maxTotalWaitMs: 5000, deadlineMs: T0 + 5000 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(call.value).toBeUndefined();
    expect(isFetchDeadlineError(call.error)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("10. gives the caller's reason when the caller aborts in the same tick the deadline fires", async () => {
    const caller = new AbortController();
    const reason = new Error('caller stopped');
    // The caller aborts synchronously inside the deadline's own abort event,
    // before fetch's rejection reaches fetchWithRetry: both have fired.
    scripted((init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal || signal === caller.signal) return;
        signal.addEventListener('abort', () => {
          caller.abort(reason);
          reject(signal.reason);
        }, { once: true });
      });
    });
    const call = track(fetchWithRetry(URL_, { signal: caller.signal }, { deadlineMs: T0 + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.settled).toBe(true);
    expect(call.error).toBe(reason);
    expect(isFetchDeadlineError(call.error)).toBe(false);
  });

  it("11. ends with the caller's own reason when the caller aborts before the deadline", async () => {
    scripted(hangUntilAborted);
    const caller = new AbortController();
    const reason = new Error('caller stopped');
    const call = track(fetchWithRetry(URL_, { signal: caller.signal }, { deadlineMs: T0 + 5000 }));
    await vi.advanceTimersByTimeAsync(200);
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(call.error).toBe(reason);
    expect(isFetchDeadlineError(call.error)).toBe(false);
  });

  it('12. still sleeps and retries a 429 whose wait ends before the deadline', async () => {
    const fn = scripted(new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }), 200);
    const call = track(fetchWithRetry(URL_, undefined, { deadlineMs: T0 + 5000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.settled).toBe(true);
    expect(call.value?.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("13. without the option, passes the caller's init through untouched", async () => {
    const fn = scripted(200);
    const init: RequestInit = { method: 'GET', headers: { accept: 'application/json' } };
    const res = await fetchWithRetry(URL_, init);
    expect(res.status).toBe(200);
    expect(fn.mock.calls[0]![1]).toBe(init);
  });
});

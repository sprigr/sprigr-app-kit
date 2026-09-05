import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attemptTimeoutMs,
  budgetExhausted,
  budgetSignal,
  createDeadline,
  DEFAULT_ATTEMPT_CAP_MS,
  DISPATCH_WALL_MS,
  FetchBudgetTimeoutError,
  fetchWithBudget,
  isAbortLike,
  isFetchBudgetTimeout,
  remainingMs,
} from '../src/index';

/** A fixed wall-clock origin so every assertion below is exact. */
const T0 = 1_700_000_000_000;

/** The exact shape fetchWithBudget calls, so mock call tuples stay typed. */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A fetch that never settles, to stand in for a connection that hangs. */
const neverSettles: FetchImpl = () => new Promise<Response>(() => {});

/** A response body is irrelevant here; only the identity is asserted. */
function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

const respondWith = (response: Response): FetchImpl => async () => response;
const rejectWith = (err: unknown): FetchImpl => async () => {
  throw err;
};

describe('createDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('anchors on the current clock by default', () => {
    expect(createDeadline(25_000)).toEqual({ at: T0 + 25_000 });
  });

  it('accepts an explicit now, so a caller can anchor on an event timestamp', () => {
    expect(createDeadline(5_000, 42)).toEqual({ at: 5_042 });
  });

  it('clamps a negative total to the current instant rather than into the past', () => {
    expect(createDeadline(-5_000)).toEqual({ at: T0 });
  });

  it('does not move as the clock advances (it is an absolute cap, not a duration)', () => {
    const deadline = createDeadline(10_000);
    vi.advanceTimersByTime(4_000);
    expect(deadline.at).toBe(T0 + 10_000);
    expect(remainingMs(deadline)).toBe(6_000);
  });
});

describe('remainingMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is Infinity when there is no deadline', () => {
    expect(remainingMs(undefined)).toBe(Infinity);
  });

  it('counts down with the clock', () => {
    const deadline = createDeadline(1_000);
    expect(remainingMs(deadline)).toBe(1_000);
    vi.advanceTimersByTime(600);
    expect(remainingMs(deadline)).toBe(400);
  });

  it('goes negative past the deadline, so callers can log the overrun', () => {
    const deadline = createDeadline(1_000);
    vi.advanceTimersByTime(1_500);
    expect(remainingMs(deadline)).toBe(-500);
  });
});

describe('budgetExhausted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false without a deadline', () => {
    expect(budgetExhausted(undefined)).toBe(false);
    expect(budgetExhausted(undefined, 60_000)).toBe(false);
  });

  it('is false while time remains and true once it does not', () => {
    const deadline = createDeadline(1_000);
    expect(budgetExhausted(deadline)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(budgetExhausted(deadline)).toBe(true);
  });

  it('honours a minimum-useful-leg floor', () => {
    const deadline = createDeadline(3_000);
    expect(budgetExhausted(deadline, 2_000)).toBe(false);
    vi.advanceTimersByTime(1_500);
    // 1500ms left, which is less than the 2000ms floor the caller needs.
    expect(budgetExhausted(deadline, 2_000)).toBe(true);
    expect(budgetExhausted(deadline)).toBe(false);
  });
});

describe('attemptTimeoutMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the cap untouched when there is no deadline', () => {
    expect(attemptTimeoutMs(undefined, 15_000)).toBe(15_000);
  });

  it('returns the cap when the deadline leaves more room than the cap', () => {
    expect(attemptTimeoutMs(createDeadline(60_000), 15_000)).toBe(15_000);
  });

  it('clamps to the time left when the deadline is nearer than the cap', () => {
    const deadline = createDeadline(20_000);
    vi.advanceTimersByTime(12_000);
    expect(attemptTimeoutMs(deadline, 15_000)).toBe(8_000);
  });

  it('is 0, never negative, once the deadline has passed', () => {
    const deadline = createDeadline(1_000);
    vi.advanceTimersByTime(9_000);
    expect(attemptTimeoutMs(deadline, 15_000)).toBe(0);
  });

  it('clamps a negative cap to 0', () => {
    expect(attemptTimeoutMs(undefined, -5)).toBe(0);
  });
});

describe('FetchBudgetTimeoutError', () => {
  it('is retryable and strips the query string from the message', () => {
    const err = new FetchBudgetTimeoutError('https://api.example.com/orders?token=secret', 15_000, 'attempt');
    expect(err.retryable).toBe(true);
    expect(err.phase).toBe('attempt');
    expect(err.timeoutMs).toBe(15_000);
    expect(err.name).toBe('FetchBudgetTimeoutError');
    expect(err.message).toContain('https://api.example.com/orders');
    expect(err.message).not.toContain('secret');
    expect(isFetchBudgetTimeout(err)).toBe(true);
    expect(isFetchBudgetTimeout(new Error('nope'))).toBe(false);
  });
});

describe('isAbortLike', () => {
  it('matches abort and timeout rejections by name', () => {
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    const abort = new Error('a');
    abort.name = 'AbortError';
    expect(isAbortLike(timeout)).toBe(true);
    expect(isAbortLike(abort)).toBe(true);
  });

  it('does not match a network error or a non-Error', () => {
    expect(isAbortLike(new TypeError('fetch failed'))).toBe(false);
    expect(isAbortLike('AbortError')).toBe(false);
    expect(isAbortLike(undefined)).toBe(false);
  });
});

describe('fetchWithBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the response and leaves no timer behind on success', async () => {
    const response = okResponse();
    const fetchImpl = vi.fn(respondWith(response));
    await expect(
      fetchWithBudget('https://api.example.com/x', undefined, createDeadline(30_000), {
        attemptCapMs: 15_000,
        fetchImpl,
      }),
    ).resolves.toBe(response);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards init and injects a signal the caller did not supply', async () => {
    const fetchImpl = vi.fn(respondWith(okResponse()));
    await fetchWithBudget(
      'https://api.example.com/x',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      undefined,
      { fetchImpl },
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('aborts a never-resolving fetch at the attempt cap', async () => {
    const fetchImpl = vi.fn(neverSettles);
    const promise = fetchWithBudget('https://api.example.com/slow?sig=abc', undefined, undefined, {
      attemptCapMs: 15_000,
      fetchImpl,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'FetchBudgetTimeoutError',
      phase: 'attempt',
      timeoutMs: 15_000,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // The hung request is cancelled, not merely abandoned.
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
  });

  it('does not fire before the cap elapses', async () => {
    const fetchImpl = vi.fn(neverSettles);
    let settled = false;
    const promise = fetchWithBudget('https://api.example.com/slow', undefined, undefined, {
      attemptCapMs: 15_000,
      fetchImpl,
    }).catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toBe(true);
  });

  it('uses the default attempt cap when the caller names none', async () => {
    const fetchImpl = vi.fn(neverSettles);
    const promise = fetchWithBudget('https://api.example.com/slow', undefined, undefined, { fetchImpl });
    const assertion = expect(promise).rejects.toMatchObject({ timeoutMs: DEFAULT_ATTEMPT_CAP_MS });
    await vi.advanceTimersByTimeAsync(DEFAULT_ATTEMPT_CAP_MS);
    await assertion;
  });

  it('aborts AT the deadline, not a full cap past it, and reports the budget phase', async () => {
    const deadline = createDeadline(20_000);
    vi.setSystemTime(T0 + 12_000); // 8s of budget left, cap is 15s
    const fetchImpl = vi.fn(neverSettles);
    const promise = fetchWithBudget('https://api.example.com/slow', undefined, deadline, {
      attemptCapMs: 15_000,
      fetchImpl,
    });
    const assertion = expect(promise).rejects.toMatchObject({ phase: 'budget', timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it('refuses to open a request once the deadline has passed', async () => {
    const deadline = createDeadline(1_000);
    vi.advanceTimersByTime(1_000);
    const fetchImpl = vi.fn(respondWith(okResponse()));
    await expect(
      fetchWithBudget('https://api.example.com/x', undefined, deadline, {
        attemptCapMs: 15_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: 'FetchBudgetTimeoutError', phase: 'budget', timeoutMs: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('composes the caller signal instead of replacing it', async () => {
    const controller = new AbortController();
    const callerAbort = new Error('caller gave up');
    callerAbort.name = 'AbortError';
    const rejectOnAbort: FetchImpl = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(callerAbort), { once: true });
      });
    const fetchImpl = vi.fn(rejectOnAbort);
    const promise = fetchWithBudget('https://api.example.com/x', { signal: controller.signal }, undefined, {
      attemptCapMs: 15_000,
      fetchImpl,
    });
    controller.abort();
    // A caller-driven abort is the caller's own error, not a budget timeout.
    await expect(promise).rejects.toBe(callerAbort);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps an abort thrown by the underlying fetch to a budget timeout', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'TimeoutError';
    const fetchImpl = vi.fn(rejectWith(abort));
    await expect(
      fetchWithBudget('https://api.example.com/x', undefined, undefined, {
        attemptCapMs: 15_000,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(FetchBudgetTimeoutError);
  });

  it('rethrows a network error untouched', async () => {
    const netErr = new TypeError('fetch failed');
    const fetchImpl = vi.fn(rejectWith(netErr));
    await expect(
      fetchWithBudget('https://api.example.com/x', undefined, undefined, { fetchImpl }),
    ).rejects.toBe(netErr);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a URL object and a Request as input', async () => {
    const fetchImpl = vi.fn(neverSettles);
    const promise = fetchWithBudget(new URL('https://api.example.com/u?x=1'), undefined, undefined, {
      attemptCapMs: 1_000,
      fetchImpl,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      url: 'https://api.example.com/u?x=1',
      message: expect.stringContaining('https://api.example.com/u'),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

describe('budgetSignal', () => {
  it('reflects an already-aborted caller signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(budgetSignal(undefined, 15_000, controller.signal).aborted).toBe(true);
  });

  it('is not aborted while budget remains', () => {
    expect(budgetSignal(createDeadline(30_000), 15_000).aborted).toBe(false);
  });

  it('fires immediately when the deadline has already passed', async () => {
    // Real timers: AbortSignal.timeout is native and does not observe
    // vitest's fake clock.
    const signal = budgetSignal({ at: Date.now() - 1 }, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal.aborted).toBe(true);
  });
});

describe('DISPATCH_WALL_MS', () => {
  it('names the platform dispatcher wall a budget is sized against', () => {
    expect(DISPATCH_WALL_MS).toBe(110_000);
    expect(DEFAULT_ATTEMPT_CAP_MS).toBeLessThan(DISPATCH_WALL_MS);
  });
});

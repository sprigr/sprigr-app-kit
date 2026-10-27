/**
 * fetchWithRetry retries only what is safe to send twice (sprigr-app-kit#83).
 *
 * A 5xx or a thrown network error can follow a write the provider already
 * committed, so only an idempotent request is sent again after one: GET,
 * HEAD, OPTIONS, a request carrying an Idempotency-Key or Idempotency-Token
 * header, or a caller that says `idempotent: true`. A 429 means nothing was
 * processed and is retried for every method. The caller's own abort or
 * timeout ends the call at once, and a response dropped for a retry has its
 * body cancelled.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/fetch';

type Step = number | Error | ((init?: RequestInit) => Response | Promise<Response>);

/** A fetch that answers each call with the next step: a status, a thrown error, or a builder. */
function scripted(...steps: Step[]) {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw signal.reason;
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(init);
    return new Response(`body ${step}`, { status: step });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const FAST = { baseBackoffMs: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchWithRetry: 5xx and network errors are retried only for idempotent requests (#83)', () => {
  it('a POST answered 502 is sent once, and the 502 comes back readable', async () => {
    const { fn } = scripted(502, 201);
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'POST', body: '{}' }, FAST);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('body 502');
  });

  it.each(['PATCH', 'PUT', 'DELETE', 'post'])('a %s answered 503 is sent once', async (method) => {
    const { fn } = scripted(503, 200);
    const res = await fetchWithRetry('https://api.example.test/things/1', { method }, FAST);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
  });

  it('a POST whose connection drops after sending is not sent again', async () => {
    const { fn } = scripted(new TypeError('network connection lost'), 201);
    await expect(
      fetchWithRetry('https://api.example.test/things', { method: 'POST', body: '{}' }, FAST),
    ).rejects.toThrow('network connection lost');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a POST Request object answered 502 is sent once (the method is read from the Request)', async () => {
    const { fn } = scripted(502, 201);
    const req = new Request('https://api.example.test/things', { method: 'POST', body: '{}' });
    const res = await fetchWithRetry(req, undefined, FAST);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
  });

  it.each([
    ['GET', { method: 'GET' }],
    ['HEAD', { method: 'HEAD' }],
    ['OPTIONS', { method: 'OPTIONS' }],
    ['no init (GET by default)', undefined],
  ] as const)('a %s answered 502 is retried', async (_label, init) => {
    const { fn } = scripted(502, 200);
    const res = await fetchWithRetry('https://api.example.test/things', init as RequestInit | undefined, FAST);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('a GET whose connection drops is retried', async () => {
    const { fn } = scripted(new TypeError('fetch failed'), 200);
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'GET' }, FAST);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it.each([
    ['an Idempotency-Key header (record)', { 'Idempotency-Key': 'k-1' }],
    ['an idempotency-key header (Headers, lower case)', new Headers({ 'idempotency-key': 'k-1' })],
    ['an Idempotency-Token header (procore)', [['Idempotency-Token', 't-1']] as [string, string][]],
  ])('a POST with %s is retried on 502 and on a dropped connection', async (_label, headers) => {
    const { fn } = scripted(502, new TypeError('fetch failed'), 201);
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'POST', headers, body: '{}' }, FAST);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(201);
  });

  it('an empty Idempotency-Key does not count', async () => {
    const { fn } = scripted(502, 201);
    const res = await fetchWithRetry(
      'https://api.example.test/things',
      { method: 'POST', headers: { 'Idempotency-Key': '' }, body: '{}' },
      FAST,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
  });

  it('idempotent: true retries a read sent as POST (a GraphQL or search query)', async () => {
    const { fn } = scripted(504, 200);
    const res = await fetchWithRetry(
      'https://api.example.test/graphql',
      { method: 'POST', body: '{"query":"{ x }"}' },
      { ...FAST, idempotent: true },
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('idempotent: false keeps even a GET to one attempt on a 5xx', async () => {
    const { fn } = scripted(502, 200);
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'GET' }, { ...FAST, idempotent: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
  });
});

describe('fetchWithRetry: 429 is retried for every method', () => {
  it('a POST answered 429 is retried', async () => {
    const { fn } = scripted(429, 201);
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'POST', body: '{}' }, FAST);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(201);
  });

  it('idempotent: false still retries a 429, and Retry-After sets the wait', async () => {
    scripted(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }), 201);
    const waits: number[] = [];
    vi.useFakeTimers();
    const pending = fetchWithRetry(
      'https://api.example.test/things',
      { method: 'POST', body: '{}' },
      { idempotent: false, onRetry: (i) => waits.push(i.waitMs) },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.status).toBe(201);
    expect(waits).toEqual([1_000]);
  });
});

describe("fetchWithRetry: the caller's abort or timeout is never retried", () => {
  it('the caller aborts mid-backoff and no further attempt is made', async () => {
    vi.useFakeTimers();
    const { fn } = scripted(503, 200);
    const controller = new AbortController();
    const pending = fetchWithRetry(
      'https://api.example.test/things',
      { method: 'GET', signal: controller.signal },
      { baseBackoffMs: 10_000 },
    );
    const outcome = pending.then(
      (r) => ({ ok: true as const, status: r.status }),
      (e: unknown) => ({ ok: false as const, name: (e as Error).name }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toEqual({ ok: false, name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the caller aborts mid-backoff on a Request signal and no further attempt is made', async () => {
    vi.useFakeTimers();
    const { fn } = scripted(503, 200);
    const controller = new AbortController();
    const req = new Request('https://api.example.test/things', { signal: controller.signal });
    const outcome = fetchWithRetry(req, undefined, { baseBackoffMs: 10_000 }).then(
      () => 'resolved',
      (e: unknown) => (e as Error).name,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toBe('AbortError');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(['AbortError', 'TimeoutError'])('a GET whose fetch throws %s is not retried', async (name) => {
    const { fn } = scripted(new DOMException('stopped', name), 200);
    await expect(fetchWithRetry('https://api.example.test/things', { method: 'GET' }, FAST)).rejects.toMatchObject({ name });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a signal that already fired makes exactly one attempt', async () => {
    const { fn } = scripted(200);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithRetry('https://api.example.test/things', { method: 'GET', signal: controller.signal }, FAST),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithRetry: a dropped response has its body cancelled', () => {
  it('cancels the body of a 5xx it retries past, and leaves the returned one readable', async () => {
    const cancelled: string[] = [];
    const streamed = (label: string, status: number) => () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(label));
            c.close();
          },
          cancel() {
            cancelled.push(label);
          },
        }),
        { status },
      );
    scripted(streamed('first 503', 503), streamed('then 200', 200));
    const res = await fetchWithRetry('https://api.example.test/things', { method: 'GET' }, FAST);
    expect(cancelled).toEqual(['first 503']);
    expect(await res.text()).toBe('then 200');
  });

  it('cancels the body of a 429 it retries past', async () => {
    const cancel = vi.fn();
    scripted(
      () => new Response(new ReadableStream({ cancel }), { status: 429 }),
      201,
    );
    await fetchWithRetry('https://api.example.test/things', { method: 'POST', body: '{}' }, FAST);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithRetry: unchanged behaviour (must not regress)', () => {
  it('a GET that keeps failing 503 makes maxAttempts attempts and returns the last response', async () => {
    const { fn } = scripted(503);
    const res = await fetchWithRetry('https://api.example.test/things', undefined, { ...FAST, maxAttempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(503);
  });

  it('a GET that keeps failing to connect throws the last error after maxAttempts', async () => {
    const { fn } = scripted(new TypeError('fetch failed'));
    await expect(fetchWithRetry('https://api.example.test/things', undefined, { ...FAST, maxAttempts: 3 })).rejects.toThrow(
      'fetch failed',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 404, 409])('a %s is never retried', async (status) => {
    const { fn } = scripted(status, 200);
    const res = await fetchWithRetry('https://api.example.test/things', undefined, FAST);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(status);
  });

  it('returns the 5xx instead of waiting past maxTotalWaitMs', async () => {
    const { fn } = scripted(() => new Response('', { status: 503, headers: { 'Retry-After': '60' } }), 200);
    const res = await fetchWithRetry('https://api.example.test/things', undefined, { maxTotalWaitMs: 1_000 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
  });

  it('reports each retry through onRetry with its reason', async () => {
    scripted(429, 502, new TypeError('fetch failed'), 200);
    const reasons: string[] = [];
    await fetchWithRetry('https://api.example.test/things', undefined, { ...FAST, onRetry: (i) => reasons.push(i.reason) });
    expect(reasons).toEqual(['rate_limited', 'server_error', 'network_error']);
  });

  it('passes input and init through to fetch unchanged', async () => {
    const { calls } = scripted(200);
    const init = { method: 'POST', headers: { 'x-a': '1' }, body: 'b' };
    await fetchWithRetry('https://api.example.test/things', init, FAST);
    expect(calls[0]!.input).toBe('https://api.example.test/things');
    expect(calls[0]!.init).toBe(init);
  });
});

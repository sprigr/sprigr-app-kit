import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../src/fetch';

const fast = { baseBackoffMs: 1 };

function answers(...statuses: number[]) {
  const responses = statuses.map((s) => new Response(s === 204 ? null : `status ${s}`, { status: s }));
  const mock = vi.fn(async () => responses.shift() ?? new Response('exhausted', { status: 599 }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('fetchWithRetry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not resend a POST that got a 5xx, since the write may have landed', async () => {
    const mock = answers(502, 201);
    const resp = await fetchWithRetry('https://api.example.com/x', { method: 'POST', body: '{}' }, fast);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(502);
  });

  it('retries a GET that got a 5xx', async () => {
    const mock = answers(502, 201);
    const resp = await fetchWithRetry('https://api.example.com/x', { method: 'GET' }, fast);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(resp.status).toBe(201);
  });

  it('retries a POST that carries an Idempotency-Key or the explicit opt-in', async () => {
    let mock = answers(503, 201);
    await fetchWithRetry('https://api.example.com/x', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'k1' } }, fast);
    expect(mock).toHaveBeenCalledTimes(2);
    mock = answers(503, 204);
    await fetchWithRetry('https://api.example.com/x', { method: 'DELETE' }, { ...fast, retryNonIdempotent: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('still retries a POST on 429, which means the request was not processed', async () => {
    const mock = answers(429, 201);
    const resp = await fetchWithRetry('https://api.example.com/x', { method: 'POST', body: '{}' }, fast);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(resp.status).toBe(201);
  });

  it('rethrows an abort at once without sleeping or retrying', async () => {
    const mock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', mock);
    const onRetry = vi.fn();
    await expect(fetchWithRetry('https://api.example.com/x', { method: 'GET' }, { ...fast, onRetry })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not resend a POST after a network error', async () => {
    const mock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    vi.stubGlobal('fetch', mock);
    await expect(fetchWithRetry('https://api.example.com/x', { method: 'POST', body: '{}' }, fast)).rejects.toThrow('network down');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('cancels the body of a response it is about to retry', async () => {
    const first = new Response('busy', { status: 503 });
    const cancel = vi.spyOn(first.body!, 'cancel');
    const mock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', mock);
    const resp = await fetchWithRetry('https://api.example.com/x', undefined, fast);
    expect(resp.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

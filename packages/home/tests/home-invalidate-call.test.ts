/**
 * `invalidateHome`: the binding when a handler has one, the install-token POST
 * when it does not, and never a throw, because a write that already succeeded
 * must not fail on a stale Home answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_INVALIDATE_PATH, HOME_INVALIDATE_TIMEOUT_MS, invalidateHome } from '../src/index';

const routeEnv = { SPRIGR_PLATFORM_BASE: 'https://platform.test/', SPRIGR_INSTALL_TOKEN: 'tok_1' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('invalidateHome', () => {
  it('uses env.SPRIGR.home.invalidate when the handler has it, and does not POST', async () => {
    const invalidate = vi.fn(async () => ({ ok: true as const }));
    const fetch = vi.fn();
    const res = await invalidateHome({ ...routeEnv, SPRIGR: { home: { invalidate } } }, { provider: 'money' }, { fetch });
    expect(res).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledWith({ provider: 'money' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes a binding refusal through as ok:false and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidate = vi.fn(async () => ({ ok: false as const, error: 'home_read_only' }));
    const res = await invalidateHome({ SPRIGR: { home: { invalidate } } }, { provider: 'money' });
    expect(res).toMatchObject({ ok: false, error: 'home_read_only' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[home-invalidate] money: home_read_only'));
  });

  it('resolves binding_failed when the binding throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidate = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await invalidateHome({ SPRIGR: { home: { invalidate } } }, { provider: 'money' });
    expect(res).toMatchObject({ ok: false, error: 'binding_failed', detail: 'boom' });
  });

  it('falls back to the install-token POST when SPRIGR cannot be read', async () => {
    const env = Object.defineProperty({ ...routeEnv }, 'SPRIGR', {
      get() {
        throw new Error('withheld');
      },
    });
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const res = await invalidateHome(env, { provider: 'money' }, { fetch });
    expect(res).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('POSTs the body to the platform with the install token on an inline route', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    const res = await invalidateHome(routeEnv, { provider: 'my_day', owner: { platformUserId: 'usr_tom' } }, { fetch });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://platform.test${HOME_INVALIDATE_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok_1', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'my_day', owner_platform_user_id: 'usr_tom' });
  });

  it('resolves http_error with the status on a non-2xx answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('no', { status: 503 }));
    const res = await invalidateHome(routeEnv, { provider: 'money' }, { fetch });
    expect(res).toMatchObject({ ok: false, error: 'http_error', status: 503 });
  });

  it('aborts a slow POST at the timeout and resolves timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const res = await invalidateHome(routeEnv, { provider: 'money' }, { fetch, timeoutMs: 10 });
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('resolves fetch_failed when the POST rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const res = await invalidateHome(routeEnv, { provider: 'money' }, { fetch });
    expect(res).toMatchObject({ ok: false, error: 'fetch_failed', detail: 'network down' });
  });

  it('resolves no_route with neither a binding nor an install token, without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn();
    expect(await invalidateHome({}, { provider: 'money' }, { fetch })).toMatchObject({ ok: false, error: 'no_route' });
    expect(await invalidateHome({ SPRIGR_PLATFORM_BASE: 'https://p.test' }, { provider: 'money' }, { fetch })).toMatchObject({
      ok: false,
      error: 'no_route',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up on a hung binding at the default timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidate = vi.fn(() => new Promise<never>(() => {}));
    let settled: unknown;
    const pending = invalidateHome({ SPRIGR: { home: { invalidate } } }, { provider: 'money' }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(HOME_INVALIDATE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('aborts a hung POST at the default timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    let settled: unknown;
    const pending = invalidateHome(routeEnv, { provider: 'money' }, { fetch }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(HOME_INVALIDATE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('refuses a bad input before calling anything', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidate = vi.fn();
    const fetch = vi.fn();
    const res = await invalidateHome({ ...routeEnv, SPRIGR: { home: { invalidate } } }, { provider: '' } as never, { fetch });
    expect(res).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(invalidate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

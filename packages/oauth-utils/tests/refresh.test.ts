import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAndPersist, getValidAccessToken } from '../src/refresh';
import { OAuthError } from '../src/errors';
import type { ProviderConfig, TokenStore } from '../src/types';

function makeStore(initial: Record<string, string> = {}): TokenStore & { _data: Record<string, string> } {
  const data = { ...initial };
  return {
    _data: data,
    async get(key) {
      return data[key] ?? null;
    },
    async put(key, value) {
      data[key] = value;
    },
    async delete(key) {
      delete data[key];
    },
  };
}

const config: ProviderConfig = {
  provider: 'procore',
  tokenUrl: 'https://login.example.com/oauth/token',
  clientId: 'cid',
  clientSecret: 'csec',
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('refreshAndPersist', () => {
  it('persists rotated refresh_token BEFORE access_token (write order)', async () => {
    const store = makeStore({ refresh_token: 'rt-old' });
    const writeOrder: string[] = [];
    const origPut = store.put;
    store.put = async (k, v) => {
      writeOrder.push(k);
      return origPut.call(store, k, v);
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    await refreshAndPersist(config, store, '', false);
    expect(writeOrder[0]).toBe('refresh_token');
    expect(writeOrder[1]).toBe('access_token');
    expect(writeOrder[2]).toBe('expires_at');
    expect(store._data.refresh_token).toBe('rt-new');
    expect(store._data.access_token).toBe('at-new');
  });

  it('throws terminal OAuthError when no refresh_token is stored', async () => {
    const store = makeStore({});
    await expect(refreshAndPersist(config, store, '', false)).rejects.toMatchObject({
      name: 'OAuthError',
      terminal: true,
      reason: 'revoked',
    });
  });

  it('retries once on bare invalid_grant (rotation race) then succeeds', async () => {
    const store = makeStore({ refresh_token: 'rt-old' });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: 'at-final', refresh_token: 'rt-final', expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await refreshAndPersist(config, store, '', false);
    expect(result).toBe('at-final');
    expect(calls).toBe(2);
    expect(store._data.refresh_token).toBe('rt-final');
  });

  it('does NOT retry on terminal invalid_grant + description', async () => {
    const store = makeStore({ refresh_token: 'rt' });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token has been revoked' }),
        { status: 400 },
      ),
    ) as unknown as typeof fetch;

    await expect(refreshAndPersist(config, store, '', false)).rejects.toMatchObject({
      name: 'OAuthError',
      terminal: true,
      reason: 'revoked',
    });
  });

  it('does not retry when isRetry=true (prevents infinite loop)', async () => {
    const store = makeStore({ refresh_token: 'rt' });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;

    await expect(refreshAndPersist(config, store, '', /* isRetry */ true)).rejects.toBeInstanceOf(OAuthError);
    expect(calls).toBe(1);
  });
});

describe('getValidAccessToken', () => {
  it('cache-hit: returns cached access_token without hitting the wire', async () => {
    const store = makeStore({
      access_token: 'cached-at',
      expires_at: String(Date.now() + 60 * 60 * 1000),
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const tok = await getValidAccessToken(config, store);
    expect(tok).toBe('cached-at');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cache-near-expiry: refreshes', async () => {
    const store = makeStore({
      refresh_token: 'rt-old',
      access_token: 'cached-at',
      expires_at: String(Date.now() + 60 * 1000), // 1 min — inside REFRESH_BUFFER_MS
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'fresh-at', refresh_token: 'rt-new', expires_in: 3600 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const tok = await getValidAccessToken(config, store);
    expect(tok).toBe('fresh-at');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeAuthCode, exchangeAndPersist } from '../src/exchange';
import { getValidAccessToken } from '../src/refresh';
import type { ProviderConfig, TokenStore } from '../src/types';

const config: ProviderConfig = {
  provider: 'testprov',
  tokenUrl: 'https://example.com/oauth/token',
  clientId: 'cid',
  clientSecret: 'csec',
};

function makeStore(initial: Record<string, string> = {}): TokenStore & { _data: Record<string, string> } {
  const data = { ...initial };
  return {
    _data: data,
    async get(k) {
      return data[k] ?? null;
    },
    async put(k, v) {
      data[k] = v;
    },
    async delete(k) {
      delete data[k];
    },
  };
}

function mockTokenResponse(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeAuthCode', () => {
  it('returns tokens on a standard refresh-token response', async () => {
    mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const res = await exchangeAuthCode(config, 'code', { redirectUri: 'https://cb' });
    expect(res).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 });
  });

  it('throws when refresh_token is missing and not explicitly allowed', async () => {
    mockTokenResponse({ access_token: 'at' });
    await expect(exchangeAuthCode(config, 'code', { redirectUri: 'https://cb' })).rejects.toThrow(
      /No refresh token returned/,
    );
  });

  it('accepts a refresh-token-less response with allowNoRefreshToken', async () => {
    mockTokenResponse({ access_token: 'at', token_type: 'Bearer' });
    const res = await exchangeAuthCode(config, 'code', {
      redirectUri: 'https://cb',
      allowNoRefreshToken: true,
    });
    expect(res).toMatchObject({ accessToken: 'at', refreshToken: null, expiresIn: null });
  });
});

describe('exchangeAndPersist for non-expiring providers', () => {
  it("persists access_token and expires_at='never', no refresh_token row", async () => {
    mockTokenResponse({ access_token: 'at' });
    const store = makeStore();
    await exchangeAndPersist(config, store, 'code', {
      redirectUri: 'https://cb',
      allowNoRefreshToken: true,
    });
    expect(store._data).toEqual({ access_token: 'at', expires_at: 'never' });
  });

  it('still persists all three keys for a standard provider', async () => {
    mockTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const store = makeStore();
    await exchangeAndPersist(config, store, 'code', { redirectUri: 'https://cb' });
    expect(store._data.refresh_token).toBe('rt');
    expect(store._data.access_token).toBe('at');
    expect(Number(store._data.expires_at)).toBeGreaterThan(Date.now());
  });
});

describe("getValidAccessToken with expires_at='never'", () => {
  it('serves the cached token without hitting the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const store = makeStore({ access_token: 'at', expires_at: 'never' });
    await expect(getValidAccessToken(config, store)).resolves.toBe('at');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a missing expires_at still triggers the refresh path (partial-write recovery)', async () => {
    const store = makeStore({ access_token: 'stale', refresh_token: 'rt' });
    mockTokenResponse({ access_token: 'fresh', expires_in: 3600 });
    await expect(getValidAccessToken(config, store)).resolves.toBe('fresh');
  });
});

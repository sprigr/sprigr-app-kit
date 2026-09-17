import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAndPersist, getValidAccessToken } from '../src/refresh';
import { exchangeAuthCode } from '../src/exchange';
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

/**
 * Issue sprigr/sprigr-team#8134: Google's invalid_grant carries
 * `error_description: "Bad Request"`, which classifyOAuthError has never
 * matched (the regex was written against Procore's shapes) and falls
 * through to `terminal: false, reason: 'transient'` forever — so a
 * genuinely revoked grant was retried indefinitely and no install was ever
 * flagged as needing reconnection. Fix keeps the description-based verdict
 * authoritative per-occurrence (a real rotation race must still self-heal
 * silently, see 'retries once on bare invalid_grant' above) and only
 * escalates once the same install fails on invalid_grant across several
 * refresh cycles in a row with no intervening success.
 */
describe('invalid_grant streak escalation (sprigr/sprigr-team#8134)', () => {
  const BAD_REQUEST_BODY = JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' });

  it('stays transient for the first two refreshAndPersist calls, escalates to terminal on the third', async () => {
    const store = makeStore({ refresh_token: 'rt' });
    globalThis.fetch = vi.fn(
      async () => new Response(BAD_REQUEST_BODY, { status: 400 }),
    ) as unknown as typeof fetch;

    const first = await refreshAndPersist(config, store, '', false).catch((e: unknown) => e);
    expect(first).toMatchObject({ name: 'OAuthError', terminal: false, reason: 'transient' });

    const second = await refreshAndPersist(config, store, '', false).catch((e: unknown) => e);
    expect(second).toMatchObject({ name: 'OAuthError', terminal: false, reason: 'transient' });

    // Today (pre-fix) this throws terminal: false forever.
    const third = await refreshAndPersist(config, store, '', false).catch((e: unknown) => e);
    expect(third).toMatchObject({ name: 'OAuthError', terminal: true });
  });

  it('resets the streak after an intervening success, so a later failure starts back at transient', async () => {
    const store = makeStore({ refresh_token: 'rt' });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      // Calls 1-4 are the two failed refreshAndPersist attempts (each
      // burns 2 fetch calls: the initial POST + the in-function
      // rotation-race retry). Call 5 succeeds. Calls 6+ fail again.
      if (calls === 5) {
        return new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt-2', expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(BAD_REQUEST_BODY, { status: 400 });
    }) as unknown as typeof fetch;

    await refreshAndPersist(config, store, '', false).catch((e: unknown) => e); // streak 1
    await refreshAndPersist(config, store, '', false).catch((e: unknown) => e); // streak 2
    const tok = await refreshAndPersist(config, store, '', false); // success, resets streak
    expect(tok).toBe('at');

    const next = await refreshAndPersist(config, store, '', false).catch((e: unknown) => e);
    expect(next).toMatchObject({ name: 'OAuthError', terminal: false, reason: 'transient' });
  });

  it('does not escalate a genuine rotation race that self-heals on every occurrence', async () => {
    // Must-not-regress: a sibling worker rotating the token concurrently
    // fails the odd-numbered POST and succeeds on the in-function retry
    // (the even-numbered POST) every single time. The external streak
    // counter must never see two failures in a row, so it should never
    // reach the escalate threshold no matter how many refresh cycles run.
    const store = makeStore({ refresh_token: 'rt-old' });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls % 2 === 1) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt-new', expires_in: 3600 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    for (let i = 0; i < 5; i++) {
      const tok = await refreshAndPersist(config, store, '', false);
      expect(tok).toBe('at');
    }
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

/**
 * Regression for sprigr/sprigr-apps#560: the provider's raw token-endpoint body must not
 * reach `OAuthError.message`, because every consuming app writes that
 * message into a durable per-install audit column.
 */
describe('sprigr/sprigr-apps#560: raw provider body never reaches OAuthError.message', () => {
  const CREDENTIAL_BODY =
    'client_secret=SENTINEL_client_secret_1234&code=SENTINEL_auth_code_5678' +
    '&refresh_token=SENTINEL_refresh_token_9012<html>internal stack trace</html>';

  it('refreshOAuthToken omits it, keeps status + classification', async () => {
    const store = makeStore({ refresh_token: 'rt-old' });
    globalThis.fetch = vi.fn(
      async () => new Response(CREDENTIAL_BODY, { status: 400 }),
    ) as unknown as typeof fetch;

    const err = await refreshAndPersist(config, store, '', /* isRetry */ true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    const message = (err as OAuthError).message;

    expect(message).not.toContain('SENTINEL_client_secret_1234');
    expect(message).not.toContain('SENTINEL_auth_code_5678');
    expect(message).not.toContain('SENTINEL_refresh_token_9012');
    expect(message).not.toContain('internal stack trace');

    // Still diagnosable.
    expect(message).toContain('procore token refresh failed (400)');
    expect(message).toContain('reason=');
    expect(message).toContain('provider body withheld');
    expect((err as OAuthError).status).toBe(400);
  });

  it('exchangeAuthCode omits it too', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(CREDENTIAL_BODY, { status: 401 }),
    ) as unknown as typeof fetch;

    const err = await exchangeAuthCode(config, 'the-code', {
      redirectUri: 'https://example.com/cb',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).message).not.toContain('SENTINEL');
    expect((err as OAuthError).message).toContain('procore code exchange failed (401)');
  });

  it('keeps a spec-shaped JSON body error and description', async () => {
    const store = makeStore({ refresh_token: 'rt-old' });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
            client_secret: 'SENTINEL_secret_in_json_1234',
          }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;

    const err = (await refreshAndPersist(config, store, '', true).catch((e: unknown) => e)) as OAuthError;
    expect(err.message).not.toContain('SENTINEL_secret_in_json_1234');
    expect(err.message).toContain('error=invalid_grant');
    expect(err.message).toContain('Token has been expired or revoked.');
    expect(err.terminal).toBe(true);
  });
});

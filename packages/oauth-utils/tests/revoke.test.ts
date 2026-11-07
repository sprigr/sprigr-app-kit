/**
 * sprigr-team#13941: most apps drop their stored tokens on uninstall but never
 * tell the provider, so the grant stays live until it expires. The runner
 * revokes every token inside the on_uninstall hook's budget; the revokers
 * speak each provider's endpoint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asanaRevoker, googleRevoker, revokeOnUninstall, type ProviderRevoker } from '../src/revoke';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok: ProviderRevoker = async () => true;

describe('revokeOnUninstall', () => {
  it('revokes every token and returns counts, never tokens', async () => {
    const seen: string[] = [];
    const out = await revokeOnUninstall({
      targets: [{ token: 'tok-a' }, { token: 'tok-b' }],
      revoker: async (t) => (seen.push(t), true),
    });
    expect(out).toEqual({ revoked: 2, failed: 0, notReached: 0 });
    expect(seen.sort()).toEqual(['tok-a', 'tok-b']);
    expect(JSON.stringify(out)).not.toContain('tok-');
  });

  it('sends one revoke per account: later rows on it wait for that answer', async () => {
    const seen: string[] = [];
    const out = await revokeOnUninstall({
      targets: [
        { token: 'tok-1', accountKey: 'a@example.com' },
        { token: 'tok-2', accountKey: 'a@example.com' },
        { token: 'tok-3', accountKey: 'b@example.com' },
      ],
      revoker: async (t) => (seen.push(t), true),
      concurrency: 1,
    });
    expect(out).toEqual({ revoked: 3, failed: 0, notReached: 0 });
    expect(seen.sort()).toEqual(['tok-1', 'tok-3']);
  });

  it("when an account's revoke failed, the next row on it sends its own token", async () => {
    const seen: string[] = [];
    const out = await revokeOnUninstall({
      targets: [
        { token: 'stale', accountKey: 'a@example.com' },
        { token: 'fresh', accountKey: 'a@example.com' },
      ],
      revoker: async (t) => (seen.push(t), t === 'fresh'),
      concurrency: 1,
    });
    expect(seen).toEqual(['stale', 'fresh']);
    expect(out).toEqual({ revoked: 1, failed: 1, notReached: 0 });
  });

  it('a revoke that hangs is cut at timeoutMs and counted as failed', async () => {
    const hang: ProviderRevoker = () => new Promise(() => {});
    const t0 = Date.now();
    const out = await revokeOnUninstall({ targets: [{ token: 'x' }], revoker: hang, timeoutMs: 30 });
    expect(out).toEqual({ revoked: 0, failed: 1, notReached: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('aborts the revoker signal when the timeout fires', async () => {
    let aborted = false;
    const listens: ProviderRevoker = (_t, { signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve(false))));
    await revokeOnUninstall({ targets: [{ token: 'x' }], revoker: listens, timeoutMs: 20 });
    expect(aborted).toBe(true);
  });

  it('a revoker that throws is a failure, not a thrown hook', async () => {
    const boom: ProviderRevoker = async () => {
      throw new Error('network down');
    };
    expect(await revokeOnUninstall({ targets: [{ token: 'x' }, { token: 'y' }], revoker: boom })).toEqual({
      revoked: 0,
      failed: 2,
      notReached: 0,
    });
  });

  it('starts no revoke once less than timeoutMs of the deadline is left', async () => {
    let now = 1_000;
    const calls: string[] = [];
    const out = await revokeOnUninstall({
      targets: [{ token: 'first' }, { token: 'second' }, { token: 'third' }],
      revoker: async (t) => {
        calls.push(t);
        now += 4_000;
        return true;
      },
      concurrency: 1,
      timeoutMs: 5_000,
      deadlineAt: 13_000,
      now: () => now,
    });
    expect(calls).toEqual(['first', 'second']);
    expect(out).toEqual({ revoked: 2, failed: 0, notReached: 1 });
  });

  it('runs at most `concurrency` revokes at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: ProviderRevoker = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    };
    const targets = Array.from({ length: 9 }, (_, i) => ({ token: `t${i}` }));
    expect(await revokeOnUninstall({ targets, revoker: slow, concurrency: 3 })).toEqual({ revoked: 9, failed: 0, notReached: 0 });
    expect(peak).toBe(3);
  });

  it('with nothing to revoke, does nothing', async () => {
    expect(await revokeOnUninstall({ targets: [], revoker: ok })).toEqual({ revoked: 0, failed: 0, notReached: 0 });
  });
});

function stubFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function formOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit;
  return Object.fromEntries(new URLSearchParams(String(init.body)));
}

describe('googleRevoker', () => {
  it('posts the token as a form to Google and answers true on 200', async () => {
    const fetchMock = stubFetch(200);
    expect(await googleRevoker('g-token', { signal: new AbortController().signal })).toBe(true);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://oauth2.googleapis.com/revoke');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(formOf(call)).toEqual({ token: 'g-token' });
  });

  it('answers false on a non-2xx or a network error', async () => {
    stubFetch(400);
    expect(await googleRevoker('g-token', { signal: new AbortController().signal })).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(await googleRevoker('g-token', { signal: new AbortController().signal })).toBe(false);
  });
});

describe('asanaRevoker', () => {
  it('posts the token with the client credentials to Asana', async () => {
    const fetchMock = stubFetch(200);
    const revoke = asanaRevoker({ clientId: 'cid', clientSecret: 'csec' });
    expect(await revoke('a-token', { signal: new AbortController().signal })).toBe(true);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://app.asana.com/-/oauth_revoke');
    expect(formOf(call)).toEqual({ client_id: 'cid', client_secret: 'csec', token: 'a-token' });
  });
});

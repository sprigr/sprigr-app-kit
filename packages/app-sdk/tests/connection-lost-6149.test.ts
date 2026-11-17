/**
 * sprigr/sprigr-team#6149: a provider that refuses a grant for good must reach
 * a person. `actorTool` reports a terminal OAuthError to the platform's
 * connection-lost route with the CALLER's actor key only, and answers
 * `connection_lost`, distinct from `not_connected`. A transient refresh
 * failure reports nothing, and a failed report never masks the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorTool } from '../src/tool-wrappers';
import { isConnectionLostError, reportConnectionLost } from '../src/connection-lost';

/** The shape `@sprigr/apps-oauth-utils` throws, without depending on it. */
class OAuthError extends Error {
  readonly name = 'OAuthError';
  constructor(readonly terminal: boolean, message = 'refresh failed') {
    super(message);
  }
}

const BRIDGE = { SPRIGR_PLATFORM_BASE: 'https://webhooks.test/', SPRIGR_INSTALL_TOKEN: 'v2.tok' };
let calls: Array<{ url: string; auth: string | null; body: unknown }>;
let status: number;

beforeEach(() => {
  calls = [];
  status = 200;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(status === 200 ? { ok: true, notified: true } : { error: 'boom' }), { status });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const failWith = (err: Error) => actorTool<typeof BRIDGE, unknown, unknown>(async () => { throw err; });

describe('actorTool: a terminal OAuthError', () => {
  it("reports the caller's own actor key and answers connection_lost", async () => {
    const res = await failWith(new OAuthError(true))({ actor: { platformUserId: 'pu_alice', agentId: 'agt_1' } }, BRIDGE);
    expect(res).toMatchObject({ ok: false, error: 'connection_lost', status: 412 });
    expect(calls).toEqual([{ url: 'https://webhooks.test/internal/wfp/connection-lost', auth: 'Bearer v2.tok', body: { actor_key: 'u:pu_alice' } }]);
  });

  it("reports an agent's connection under its agent key", async () => {
    await failWith(new OAuthError(true))({ actor: { agentId: 'agt_1' } }, BRIDGE);
    expect(calls.map((c) => c.body)).toEqual([{ actor_key: 'a:agt_1' }]);
  });

  it('still answers connection_lost when the report fails or cannot be sent', async () => {
    status = 500;
    expect(await failWith(new OAuthError(true))({ actor: { platformUserId: 'pu_alice' } }, BRIDGE)).toMatchObject({ error: 'connection_lost' });
    calls = [];
    expect(await failWith(new OAuthError(true))({ actor: { platformUserId: 'pu_alice' } }, {} as typeof BRIDGE)).toMatchObject({ error: 'connection_lost' });
    expect(calls).toEqual([]);
  });
});

describe('nothing is reported for anything else', () => {
  it.each([
    ['a transient OAuthError', new OAuthError(false, 'invalid_grant race')],
    ['a plain error', new Error('HTTP 503')],
  ])('%s', async (_label, err) => {
    const res = await failWith(err)({ actor: { platformUserId: 'pu_alice' } }, BRIDGE);
    expect(res).toEqual({ ok: false, error: err.message });
    expect(calls).toEqual([]);
  });
});

describe('isConnectionLostError / reportConnectionLost', () => {
  it('matches by name, so another copy of the class still matches', () => {
    const other = Object.assign(new Error('x'), { name: 'OAuthError', terminal: true });
    expect(isConnectionLostError(other)).toBe(true);
    expect(isConnectionLostError(Object.assign(new Error('x'), { name: 'OAuthError', terminal: 'yes' }))).toBe(false);
    expect(isConnectionLostError({ name: 'OAuthError', terminal: true })).toBe(false);
  });

  it('resolves false instead of throwing when the platform refuses', async () => {
    status = 404;
    await expect(reportConnectionLost(BRIDGE, 'u:pu_gone')).resolves.toBe(false);
  });
});

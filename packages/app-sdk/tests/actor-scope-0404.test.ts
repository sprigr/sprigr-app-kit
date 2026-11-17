/**
 * sprigr-team decision 0404: the platform holds a workflow's triggers when a
 * tool answers `{ ok: false, status: 412, scope: 'actor' }`, which means only
 * a person reconnecting can fix it. So `actorTool` sets the scope on exactly
 * its reconnect-only failures, and on nothing else: a scope on a fault that a
 * reconnect would not fix stops that workflow for up to 6 hours.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actorTool, NotConnectedError } from '../src/tool-wrappers';

class OAuthError extends Error {
  readonly name = 'OAuthError';
  constructor(readonly terminal: boolean) {
    super('refresh failed');
  }
}

const ENV = { SPRIGR_PLATFORM_BASE: 'https://webhooks.test/', SPRIGR_INSTALL_TOKEN: 'v2.tok' };
const ACTOR = { actor: { platformUserId: 'usr_alice' } };
const failWith = (err: Error, opts = {}) =>
  actorTool<typeof ENV, unknown, never>(async () => { throw err; }, opts);

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("actorTool marks reconnect-only failures scope: 'actor'", () => {
  it('not_connected', async () => {
    expect(await failWith(new NotConnectedError())(ACTOR, ENV))
      .toMatchObject({ ok: false, error: 'not_connected', status: 412, scope: 'actor' });
  });

  it('connection_lost', async () => {
    expect(await failWith(new OAuthError(true))(ACTOR, ENV))
      .toMatchObject({ ok: false, error: 'connection_lost', status: 412, scope: 'actor' });
  });
});

describe('and leaves it off everything a reconnect would not fix', () => {
  it('no_caller_identity, a platform plumbing fault', async () => {
    const res = await failWith(new NotConnectedError())({}, ENV);
    expect(res).toMatchObject({ error: 'no_caller_identity', status: 412 });
    expect(res).not.toHaveProperty('scope');
  });

  it('a transient OAuthError and any other thrown error', async () => {
    expect(await failWith(new OAuthError(false))(ACTOR, ENV)).not.toHaveProperty('scope');
    expect(await failWith(new Error('boom'))(ACTOR, ENV)).not.toHaveProperty('scope');
  });

  it('an app-mapped 412', async () => {
    const res = await failWith(new Error('precondition'), { mapError: () => ({ error: 'precondition', status: 412 }) })(ACTOR, ENV);
    expect(res).toMatchObject({ error: 'precondition', status: 412 });
    expect(res).not.toHaveProperty('scope');
  });
});

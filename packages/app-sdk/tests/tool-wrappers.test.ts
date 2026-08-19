/**
 * The wrappers are a SECURITY boundary, not sugar.
 *
 * These pin the fail-closed behaviour that the gorgias app got wrong in
 * production: with no connection for the caller it fell back to the first
 * connected actor on the install, so one person's consent exposed their
 * account to every agent. The rule is "resolve the caller's own credential or
 * refuse", and the tests below are what stops a helpful-looking fallback
 * being reintroduced here where every app would inherit it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  tool,
  actorTool,
  createToolWrappers,
  NotConnectedError,
  isNotConnectedError,
} from '../src/tool-wrappers';

interface Env {
  marker: string;
}
const env: Env = { marker: 'env' };
const ACTOR = { actor: { platformUserId: 'usr_alice' } };

describe('actorTool: fails closed on identity', () => {
  it('refuses when the platform stamped no actor, without running the handler', async () => {
    const fn = vi.fn();
    const res = await actorTool<Env, unknown, unknown>(fn)({}, env);

    expect(res).toMatchObject({ ok: false, error: 'no_caller_identity', status: 412 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an actor object with neither id set', async () => {
    const fn = vi.fn();
    const res = await actorTool<Env, unknown, unknown>(fn)({ actor: { role: 'admin' } }, env);

    expect(res).toMatchObject({ ok: false, error: 'no_caller_identity' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('IGNORES a flat body field, which an agent controls and could spoof', async () => {
    // parseActor reads the nested, platform-stamped `args.actor` only.
    // Honouring a flat field would let a caller name any colleague.
    const fn = vi.fn();
    const res = await actorTool<Env, unknown, unknown>(fn)(
      { platformUserId: 'usr_someone_else' },
      env,
    );

    expect(res).toMatchObject({ ok: false, error: 'no_caller_identity' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes the resolved actor through to the handler, args-flipped', async () => {
    const seen: unknown[] = [];
    const wrapped = actorTool<Env, { q: string }, string>(async (e, actor, args) => {
      seen.push(e, actor, args);
      return 'done';
    });

    const res = await wrapped({ ...ACTOR, q: 'hello' } as never, env);

    expect(res).toEqual({ ok: true, result: 'done' });
    expect(seen[0]).toBe(env);
    expect(seen[1]).toEqual({ platformUserId: 'usr_alice' });
  });

  it('an unbound agent caller (agentId only) is a valid identity', async () => {
    const wrapped = actorTool<Env, unknown, string>(async () => 'ok');
    const res = await wrapped({ actor: { agentId: 'agt_1' } }, env);
    expect(res).toEqual({ ok: true, result: 'ok' });
  });
});

describe('actorTool: not_connected is distinct and actionable', () => {
  it('maps NotConnectedError to a 412 the agent can act on', async () => {
    const wrapped = actorTool<Env, unknown, never>(async () => {
      throw new NotConnectedError();
    });
    const res = await wrapped(ACTOR, env);

    expect(res).toMatchObject({ ok: false, error: 'not_connected', status: 412 });
  });

  it('carries the app-supplied connect hint verbatim', async () => {
    const wrapped = actorTool<Env, unknown, never>(
      async () => {
        throw new NotConnectedError();
      },
      { notConnectedHint: 'Call ms_connect and send the user the link.' },
    );
    const res = await wrapped(ACTOR, env);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.hint).toBe('Call ms_connect and send the user the link.');
  });

  it('keeps no_caller_identity and not_connected DISTINCT', async () => {
    // Different faults with different fixes: one is a plumbing problem to
    // retry differently, the other the agent resolves with a consent link.
    const wrapped = actorTool<Env, unknown, never>(async () => {
      throw new NotConnectedError();
    });
    const missing = await wrapped({}, env);
    const unconnected = await wrapped(ACTOR, env);

    expect(missing).toMatchObject({ error: 'no_caller_identity' });
    expect(unconnected).toMatchObject({ error: 'not_connected' });
  });

  it('recognises a NotConnectedError from a DIFFERENT copy of this module', async () => {
    // The vendor pattern (`sprigrVendor` mirrors this source into an app's
    // src/lib/vendor/) can put two distinct class identities in one isolate,
    // and `instanceof` across them is false. Falling through to the generic
    // branch would hand the agent an opaque message instead of the connect
    // cue, silently.
    class ForeignNotConnectedError extends Error {
      constructor() {
        super('no connection');
        this.name = 'NotConnectedError';
      }
    }
    expect(new ForeignNotConnectedError() instanceof NotConnectedError).toBe(false);
    expect(isNotConnectedError(new ForeignNotConnectedError())).toBe(true);

    const wrapped = actorTool<Env, unknown, never>(async () => {
      throw new ForeignNotConnectedError();
    });
    expect(await wrapped(ACTOR, env)).toMatchObject({ error: 'not_connected', status: 412 });
  });

  it('does not mistake an unrelated error for not_connected', async () => {
    const wrapped = actorTool<Env, unknown, never>(async () => {
      throw new Error('NotConnectedError is mentioned in this message');
    });
    const res = await wrapped(ACTOR, env);
    expect(res).toMatchObject({ ok: false, error: 'NotConnectedError is mentioned in this message' });
    expect((res as { status?: number }).status).toBeUndefined();
  });
});

describe('error shaping', () => {
  class ProviderError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }

  it('mapError shapes a provider error and keeps its HTTP status visible', async () => {
    const wrapped = actorTool<Env, unknown, never>(
      async () => {
        throw new ProviderError('rate limited', 429);
      },
      {
        mapError: (err) =>
          err instanceof ProviderError ? { error: err.message, status: err.status } : null,
      },
    );
    expect(await wrapped(ACTOR, env)).toEqual({ ok: false, error: 'rate limited', status: 429 });
  });

  it('mapError returning null falls through to the generic message', async () => {
    const wrapped = actorTool<Env, unknown, never>(
      async () => {
        throw new Error('boom');
      },
      { mapError: () => null },
    );
    expect(await wrapped(ACTOR, env)).toEqual({ ok: false, error: 'boom' });
  });

  it('not_connected wins over mapError, so a provider 401 does not mask the connect cue', async () => {
    const wrapped = actorTool<Env, unknown, never>(
      async () => {
        throw new NotConnectedError();
      },
      { mapError: () => ({ error: 'should_not_win', status: 500 }) },
    );
    expect(await wrapped(ACTOR, env)).toMatchObject({ error: 'not_connected' });
  });

  it('a non-Error throw is stringified rather than crashing the wrapper', async () => {
    const wrapped = tool<Env, unknown, never>(async () => {
      throw 'plain string';
    });
    expect(await wrapped({}, env)).toEqual({ ok: false, error: 'plain string' });
  });
});

describe('tool: the actor-less wrapper', () => {
  it('runs without any actor, for schedules and webhooks', async () => {
    const wrapped = tool<Env, { n: number }, number>(async (_e, args) => args.n * 2);
    expect(await wrapped({ n: 21 }, env)).toEqual({ ok: true, result: 42 });
  });

  it('defaults missing args to an object so handlers can destructure', async () => {
    const wrapped = tool<Env, Record<string, unknown>, string>(async (_e, args) =>
      typeof args === 'object' ? 'object' : 'other',
    );
    expect(await wrapped(undefined as never, env)).toEqual({ ok: true, result: 'object' });
  });
});

describe('createToolWrappers: options bound once', () => {
  it('applies the bound hint and mapError to every call', async () => {
    const { actorTool: bound } = createToolWrappers<Env>({
      notConnectedHint: 'Call gws_connect.',
      mapError: (err) => (err instanceof RangeError ? { error: 'ranged', status: 400 } : null),
    });

    const notConnected = await bound<unknown, never>(async () => {
      throw new NotConnectedError();
    })(ACTOR, env);
    const ranged = await bound<unknown, never>(async () => {
      throw new RangeError('x');
    })(ACTOR, env);

    expect(notConnected).toMatchObject({ error: 'not_connected', hint: 'Call gws_connect.' });
    expect(ranged).toEqual({ ok: false, error: 'ranged', status: 400 });
  });

  it('still fails closed on identity', async () => {
    const { actorTool: bound } = createToolWrappers<Env>({ notConnectedHint: 'x' });
    const fn = vi.fn();
    expect(await bound(fn)({}, env)).toMatchObject({ error: 'no_caller_identity', status: 412 });
    expect(fn).not.toHaveBeenCalled();
  });
});

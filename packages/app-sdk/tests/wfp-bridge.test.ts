import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  emitMarketplaceEvent,
  createMarketplaceEmitter,
  canEmit,
  withSprigrEmitFallback,
  resolveInstallBridge,
  overlaySprigr,
  installTokenPost,
} from '../src/wfp-bridge';

const BASE = 'https://staging-webhooks.sprigr.com';
const TOKEN = 'inst_abc.c2lnbmF0dXJl';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, eventId: 'evt_1', queued: true } };
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { ok: true, eventId: 'evt_1', queued: true } };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Env as an inline Next route sees it: script vars present, SPRIGR absent. */
const inlineEnv = (over: Record<string, unknown> = {}) => ({
  DB: { prepare: () => ({}) },
  SPRIGR_PLATFORM_BASE: BASE,
  SPRIGR_INSTALL_TOKEN: TOKEN,
  INSTALL_ID: 'inst_abc',
  ...over,
});

describe('resolveInstallBridge', () => {
  it('strips trailing slashes from the base', () => {
    expect(resolveInstallBridge(inlineEnv({ SPRIGR_PLATFORM_BASE: `${BASE}///` }))).toEqual({
      base: BASE,
      token: TOKEN,
    });
  });

  it('returns null when either half is missing', () => {
    expect(resolveInstallBridge(inlineEnv({ SPRIGR_INSTALL_TOKEN: undefined }))).toBeNull();
    expect(resolveInstallBridge(inlineEnv({ SPRIGR_PLATFORM_BASE: '' }))).toBeNull();
  });

  it('has no production default (a staging install must never emit into prod)', () => {
    expect(resolveInstallBridge({ SPRIGR_INSTALL_TOKEN: TOKEN })).toBeNull();
  });
});

describe('emitMarketplaceEvent — inline route (no env.SPRIGR)', () => {
  it('posts to /internal/wfp/emit with the install-token bearer', async () => {
    const r = await emitMarketplaceEvent(inlineEnv(), 'procore.rfi.updated', { rfi_id: 7 }, {
      sourceIntegration: { integrationId: 'inst_abc', integrationType: 'procore' },
    });

    expect(r).toEqual({ emitted: true, via: 'http', eventId: 'evt_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/internal/wfp/emit`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({
      event: 'procore.rfi.updated',
      payload: { rfi_id: 7 },
      sourceIntegration: { integrationId: 'inst_abc', integrationType: 'procore' },
    });
  });

  it('treats a 200 {queued:false} as NOT emitted', async () => {
    reply = { status: 200, body: { ok: true, queued: false, error: 'queue_send_failed' } };
    const r = await emitMarketplaceEvent(inlineEnv(), 'a.b.c', {});
    expect(r.emitted).toBe(false);
    expect(r.error).toBe('queue_send_failed');
  });

  it('reports a non-2xx without throwing', async () => {
    reply = { status: 401, body: { error: 'invalid install token' } };
    const r = await emitMarketplaceEvent(inlineEnv(), 'a.b.c', {});
    expect(r.emitted).toBe(false);
    expect(r.via).toBe('http');
    expect(r.error).toContain('401');
    expect(r.error).toContain('invalid install token');
  });

  it('survives an unparseable 2xx body', async () => {
    reply = { status: 200, body: 'not json' };
    const r = await emitMarketplaceEvent(inlineEnv(), 'a.b.c', {});
    expect(r.emitted).toBe(true);
  });

  it('omits opts entirely rather than sending undefined (platform 400s on a partial one)', async () => {
    await emitMarketplaceEvent(inlineEnv(), 'a.b.c', {}, { sourceIntegration: undefined });
    expect(calls[0]!.body).toEqual({ event: 'a.b.c', payload: {} });
  });

  it('serialises an undefined payload as null', async () => {
    await emitMarketplaceEvent(inlineEnv(), 'a.b.c', undefined);
    expect((calls[0]!.body as { payload: unknown }).payload).toBeNull();
  });

  it('names which binding is missing when there is no emit path at all', async () => {
    const r = await emitMarketplaceEvent(inlineEnv({ SPRIGR_INSTALL_TOKEN: undefined }), 'a.b.c', {});
    expect(r).toMatchObject({ emitted: false, via: 'none' });
    expect(r.error).toContain('SPRIGR_PLATFORM_BASE=set');
    expect(r.error).toContain('SPRIGR_INSTALL_TOKEN=unset');
    expect(calls).toHaveLength(0);
  });

  it('aborts a hung platform call instead of holding the webhook ack', async () => {
    globalThis.fetch = ((_i: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
      })) as typeof globalThis.fetch;
    const r = await emitMarketplaceEvent(inlineEnv(), 'a.b.c', {}, { timeoutMs: 10 });
    expect(r.emitted).toBe(false);
    expect(r.via).toBe('http');
  });
});

describe('emitMarketplaceEvent — dispatch path (env.SPRIGR present)', () => {
  it('prefers the injected binding and makes no HTTP call', async () => {
    const emit = vi.fn(async () => ({ ok: true, eventId: 'evt_binding' }));
    const r = await emitMarketplaceEvent(inlineEnv({ SPRIGR: { emit } }), 'a.b.c', { x: 1 }, {
      sourceIntegration: { integrationId: 'inst_abc', integrationType: 'procore' },
    });

    expect(r).toEqual({ emitted: true, via: 'binding', eventId: 'evt_binding' });
    expect(calls).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith('a.b.c', { x: 1 }, {
      sourceIntegration: { integrationId: 'inst_abc', integrationType: 'procore' },
    });
  });

  it('passes undefined opts through rather than an empty object', async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    await emitMarketplaceEvent(inlineEnv({ SPRIGR: { emit } }), 'a.b.c', {});
    expect(emit).toHaveBeenCalledWith('a.b.c', {}, undefined);
  });

  it('catches a throwing binding instead of failing the caller', async () => {
    const emit = vi.fn(async () => {
      throw new Error('bridge exploded');
    });
    const r = await emitMarketplaceEvent(inlineEnv({ SPRIGR: { emit } }), 'a.b.c', {});
    expect(r).toEqual({ emitted: false, via: 'binding', error: 'bridge exploded' });
  });

  it('catches queued:false on the binding path too', async () => {
    const emit = vi.fn(async () => ({ ok: true, queued: false, error: 'queue_send_failed' }));
    const r = await emitMarketplaceEvent(inlineEnv({ SPRIGR: { emit } }), 'a.b.c', {});
    expect(r).toMatchObject({ emitted: false, via: 'binding', error: 'queue_send_failed' });
  });

  it('ignores a SPRIGR that has no callable emit', async () => {
    const r = await emitMarketplaceEvent(inlineEnv({ SPRIGR: { data: {} } }), 'a.b.c', {});
    expect(r.via).toBe('http');
    expect(calls).toHaveLength(1);
  });
});

describe('overlaySprigr', () => {
  it('preserves prototype-chain bindings that a spread would drop', () => {
    // The dispatch-path env: bindings on the prototype, SPRIGR non-enumerable.
    const bindings = { DB: 'the-real-db', SPRIGR_INSTALL_TOKEN: TOKEN };
    const dispatchEnv = Object.create(bindings) as Record<string, unknown>;
    Object.defineProperty(dispatchEnv, 'SPRIGR', { value: { emit: () => {} }, enumerable: false });

    expect({ ...dispatchEnv }.DB).toBeUndefined(); // why spread is banned here (#758)

    const out = overlaySprigr(dispatchEnv, { emit: () => 'new' });
    expect(out.DB).toBe('the-real-db');
    expect((out.SPRIGR as { emit: () => string }).emit()).toBe('new');
  });

  it('leaves the original env untouched', () => {
    const env = { SPRIGR: 'original' };
    const out = overlaySprigr(env, 'replacement');
    expect(out.SPRIGR).toBe('replacement');
    expect(env.SPRIGR).toBe('original');
  });
});

describe('withSprigrEmitFallback', () => {
  it('installs a working emit on an inline-route env', async () => {
    const env = withSprigrEmitFallback(inlineEnv());
    const r = await (env.SPRIGR as { emit: (e: string, p: unknown) => Promise<{ eventId?: string }> }).emit(
      'a.b.c',
      { x: 1 },
    );

    expect(r.eventId).toBe('evt_1');
    expect(calls[0]!.url).toBe(`${BASE}/internal/wfp/emit`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps DB reachable (regression: spread-built envs lost it)', () => {
    const bindings = { DB: 'the-real-db', SPRIGR_PLATFORM_BASE: BASE, SPRIGR_INSTALL_TOKEN: TOKEN };
    const dispatchEnv = Object.create(bindings) as Record<string, unknown>;
    expect(withSprigrEmitFallback(dispatchEnv).DB).toBe('the-real-db');
  });

  it('throws on a non-2xx, matching the injected host object contract', async () => {
    reply = { status: 500, body: { error: 'boom' } };
    const env = withSprigrEmitFallback(inlineEnv());
    await expect(
      (env.SPRIGR as { emit: (e: string, p: unknown) => Promise<unknown> }).emit('a.b.c', {}),
    ).rejects.toThrow(/500/);
  });

  it('returns the env untouched when the binding already works', () => {
    const emit = () => {};
    const env = inlineEnv({ SPRIGR: { emit } });
    expect(withSprigrEmitFallback(env)).toBe(env);
  });

  it('returns the env untouched when there are no bindings to build from', () => {
    const env = inlineEnv({ SPRIGR_INSTALL_TOKEN: undefined });
    expect(withSprigrEmitFallback(env)).toBe(env);
  });

  it('preserves sibling namespaces already on SPRIGR', () => {
    const data = { search: () => {} };
    const env = withSprigrEmitFallback(inlineEnv({ SPRIGR: { data } }));
    const sprigr = env.SPRIGR as { data: unknown; emit: unknown };
    expect(sprigr.data).toBe(data);
    expect(typeof sprigr.emit).toBe('function');
  });
});

describe('canEmit', () => {
  it('is true when the binding is present', () => {
    expect(canEmit(inlineEnv({ SPRIGR: { emit: () => {} }, SPRIGR_INSTALL_TOKEN: undefined }))).toBe(true);
  });

  it('is true on an inline route, where only the bridge exists', () => {
    // Gating on env.SPRIGR?.emit here would skip the work in exactly the
    // context the HTTP bridge was built to cover.
    expect(canEmit(inlineEnv())).toBe(true);
  });

  it('is false when neither transport is available', () => {
    expect(canEmit(inlineEnv({ SPRIGR_INSTALL_TOKEN: undefined }))).toBe(false);
  });
});

describe('createMarketplaceEmitter', () => {
  it('stamps sourceIntegration from INSTALL_ID on every call', async () => {
    const emit = createMarketplaceEmitter('procore');
    const r = await emit(inlineEnv(), 'procore.rfi.updated', { rfi_id: 7 });

    expect(r.emitted).toBe(true);
    expect((calls[0]!.body as { sourceIntegration: unknown }).sourceIntegration).toEqual({
      integrationId: 'inst_abc',
      integrationType: 'procore',
    });
  });

  it('omits sourceIntegration entirely when INSTALL_ID is unbound', async () => {
    const emit = createMarketplaceEmitter('procore');
    await emit(inlineEnv({ INSTALL_ID: undefined }), 'a.b.c', {});
    expect(calls[0]!.body).not.toHaveProperty('sourceIntegration');
  });

  it('applies a default timeout to every call', async () => {
    globalThis.fetch = ((_i: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as typeof globalThis.fetch;
    const emit = createMarketplaceEmitter('procore', { timeoutMs: 10 });
    await expect(emit(inlineEnv(), 'a.b.c', {})).resolves.toMatchObject({ emitted: false });
  });
});

describe('installTokenPost', () => {
  it('throws with the status and error detail on a non-2xx', async () => {
    reply = { status: 403, body: { error: 'forbidden' } };
    await expect(
      installTokenPost({ base: BASE, token: TOKEN }, '/internal/wfp/emit', {}, { label: 'emit' }),
    ).rejects.toThrow('emit failed: 403 forbidden');
  });

  it('returns an empty object for an empty 2xx body', async () => {
    reply = { status: 200, body: '' };
    await expect(installTokenPost({ base: BASE, token: TOKEN }, '/x', {})).resolves.toEqual({});
  });
});

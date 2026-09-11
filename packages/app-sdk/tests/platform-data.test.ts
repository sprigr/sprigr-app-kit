import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  partialUpdateData,
  canPartialUpdate,
  buildPartialUpdateBody,
  SprigrDataValidationError,
  DATA_PARTIAL_UPDATE_PATH,
  SPRIGR_DATA_MAX_OBJECTS_PER_CALL,
} from '../src/platform-data';

const BASE = 'https://staging-webhooks.sprigr.com';
const TOKEN = 'inst_abc.c2lnbmF0dXJl';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let reply: { status: number; body: unknown } = {
  status: 200,
  body: { ok: true, updated: 1, skippedMissing: 0, index: 'orders' },
};
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { ok: true, updated: 1, skippedMissing: 0, index: 'orders' } };
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

const patch = { objectID: 'ord_1', created_at: '2026-09-01T00:00:00Z', status: 'shipped' };

describe('buildPartialUpdateBody', () => {
  it('emits { index, objects, createIfNotExists } with the default spelled out as false', () => {
    expect(buildPartialUpdateBody([patch], { index: 'orders' })).toEqual({
      index: 'orders',
      objects: [patch],
      createIfNotExists: false,
    });
  });

  it('omits index for single-index apps and honours createIfNotExists: true', () => {
    const body = buildPartialUpdateBody([patch], { createIfNotExists: true });
    expect(body).toEqual({ objects: [patch], createIfNotExists: true });
    expect('index' in body).toBe(false);
  });

  it('rejects an empty batch, a non-array, and a patch without a string objectID before sending', () => {
    for (const bad of [[], null, 'x', [{ status: 'shipped' }], [{ objectID: 7 }], [['not', 'an', 'object']]]) {
      let err: unknown;
      try {
        buildPartialUpdateBody(bad as never);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SprigrDataValidationError);
      expect((err as SprigrDataValidationError).error).toBe('invalid_object');
    }
    let indexed: unknown;
    try {
      buildPartialUpdateBody([patch, { status: 'x' }]);
    } catch (e) {
      indexed = e;
    }
    expect((indexed as SprigrDataValidationError).index).toBe(1);
  });

  it('rejects more than the import cap with the platform error code', () => {
    const many = Array.from({ length: SPRIGR_DATA_MAX_OBJECTS_PER_CALL + 1 }, (_, i) => ({ objectID: `o${i}` }));
    let err: unknown;
    try {
      buildPartialUpdateBody(many);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SprigrDataValidationError);
    expect((err as SprigrDataValidationError).error).toBe('too_many_objects');
    expect((err as Error).message).toContain('1000');
    // Exactly the cap is fine.
    expect(buildPartialUpdateBody(many.slice(0, SPRIGR_DATA_MAX_OBJECTS_PER_CALL)).objects).toHaveLength(1000);
  });

  it('rejects an empty index string rather than letting the platform guess', () => {
    expect(() => buildPartialUpdateBody([patch], { index: '' })).toThrow(SprigrDataValidationError);
  });
});

describe('partialUpdateData over the install-token bridge', () => {
  it('POSTs the body to /internal/wfp/data/partial-update with the install bearer', async () => {
    const res = await partialUpdateData(inlineEnv(), [patch], { index: 'orders' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}${DATA_PARTIAL_UPDATE_PATH}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ index: 'orders', objects: [patch], createIfNotExists: false });
    expect(res).toEqual({ ok: true, updated: 1, skippedMissing: 0, index: 'orders' });
  });

  it('defaults createIfNotExists to false and omits index when the caller passes no options', async () => {
    await partialUpdateData(inlineEnv(), [patch]);
    expect(calls[0]?.body).toEqual({ objects: [patch], createIfNotExists: false });
  });

  it('sends createIfNotExists: true when asked and strips the SDK-only timeoutMs from the body', async () => {
    await partialUpdateData(inlineEnv(), [patch], { createIfNotExists: true, timeoutMs: 1_000 });
    expect(calls[0]?.body).toEqual({ objects: [patch], createIfNotExists: true });
  });

  it('strips a trailing slash from the base', async () => {
    await partialUpdateData(inlineEnv({ SPRIGR_PLATFORM_BASE: `${BASE}/` }), [patch]);
    expect(calls[0]?.url).toBe(`${BASE}${DATA_PARTIAL_UPDATE_PATH}`);
  });

  it('propagates a platform rejection with status, error code and detail', async () => {
    reply = {
      status: 400,
      body: { error: 'shard_field_invalid', detail: 'objects[0].created_at missing', index: 'orders' },
    };
    let err: unknown;
    try {
      await partialUpdateData(inlineEnv(), [{ objectID: 'ord_1', status: 'shipped' }], { index: 'orders' });
    } catch (e) {
      err = e;
    }
    const e = err as Error & { status?: number; error?: string; detail?: string };
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('data.partialUpdate failed: 400 shard_field_invalid');
    expect(e.status).toBe(400);
    expect(e.error).toBe('shard_field_invalid');
    expect(e.detail).toBe('objects[0].created_at missing');
  });

  it('propagates a 404 (route not deployed yet) rather than reporting success', async () => {
    reply = { status: 404, body: 'not found' };
    await expect(partialUpdateData(inlineEnv(), [patch])).rejects.toMatchObject({
      status: 404,
      message: 'data.partialUpdate failed: 404 not found',
    });
  });

  it('propagates a transport failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    await expect(partialUpdateData(inlineEnv(), [patch])).rejects.toThrow('fetch failed');
  });

  it('throws a self-describing error when neither transport exists, and sends nothing', async () => {
    await expect(
      partialUpdateData({ DB: {}, SPRIGR_PLATFORM_BASE: BASE } as never, [patch]),
    ).rejects.toThrow('no_data_path (SPRIGR.data.partialUpdate absent, SPRIGR_PLATFORM_BASE=set, SPRIGR_INSTALL_TOKEN=unset)');
    expect(calls).toHaveLength(0);
  });

  it('validates before sending: a bad batch never reaches the network', async () => {
    await expect(partialUpdateData(inlineEnv(), [{ status: 'x' } as never])).rejects.toBeInstanceOf(
      SprigrDataValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('partialUpdateData with the injected host member', () => {
  it('prefers env.SPRIGR.data.partialUpdate, binds this, and passes the explicit default', async () => {
    const seen: Array<{ self: unknown; objects: unknown; opts: unknown }> = [];
    const data = {
      partialUpdate(objects: unknown, opts: unknown) {
        seen.push({ self: this, objects, opts });
        return Promise.resolve({ ok: true as const, updated: 1, skippedMissing: 0, index: 'orders' });
      },
    };
    const res = await partialUpdateData(inlineEnv({ SPRIGR: { data } }), [patch], { index: 'orders' });
    expect(calls).toHaveLength(0);
    expect(seen).toEqual([{ self: data, objects: [patch], opts: { index: 'orders', createIfNotExists: false } }]);
    expect(res.updated).toBe(1);
  });

  it('omits index from the member call when not given', async () => {
    const seen: unknown[] = [];
    const data = {
      partialUpdate: async (_o: unknown, opts: unknown) => {
        seen.push(opts);
        return { ok: true as const, updated: 0, skippedMissing: 1, index: 'x' };
      },
    };
    await partialUpdateData(inlineEnv({ SPRIGR: { data } }), [patch]);
    expect(seen).toEqual([{ createIfNotExists: false }]);
  });

  it('propagates a rejection from the member untouched', async () => {
    const boom = Object.assign(new Error('data.partialUpdate failed: 400 unknown_data_index'), {
      status: 400,
      error: 'unknown_data_index',
    });
    const data = { partialUpdate: async () => Promise.reject(boom) };
    await expect(partialUpdateData(inlineEnv({ SPRIGR: { data } }), [patch], { index: 'nope' })).rejects.toBe(boom);
  });

  it('falls back to HTTP when SPRIGR exists but has no data.partialUpdate (older wrapper build)', async () => {
    await partialUpdateData(inlineEnv({ SPRIGR: { data: { import: async () => ({}) } } }), [patch]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}${DATA_PARTIAL_UPDATE_PATH}`);
  });
});

describe('canPartialUpdate', () => {
  it('is true with the member, true with the bridge, false with neither', () => {
    expect(canPartialUpdate(inlineEnv({ SPRIGR_INSTALL_TOKEN: undefined, SPRIGR: { data: { partialUpdate: async () => ({}) } } }))).toBe(true);
    expect(canPartialUpdate(inlineEnv())).toBe(true);
    expect(canPartialUpdate({ SPRIGR_PLATFORM_BASE: BASE })).toBe(false);
    expect(canPartialUpdate({ SPRIGR: { data: {} } })).toBe(false);
  });
});

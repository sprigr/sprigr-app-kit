import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  logToPlatform,
  withSprigrLogFallback,
  canLog,
  validateLogEntry,
  validateLogEntries,
  SprigrLogValidationError,
  SPRIGR_LOG_LIMITS,
  type SprigrLogEntry,
} from '../src/platform-log';

const BASE = 'https://staging-webhooks.sprigr.com';
const TOKEN = 'inst_abc.c2lnbmF0dXJl';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, written: 1 } };
let originalFetch: typeof globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { ok: true, written: 1 } };
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
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  warn.mockRestore();
});

/** Env as an inline Next route sees it: script vars present, SPRIGR absent. */
const inlineEnv = (over: Record<string, unknown> = {}) => ({
  DB: { prepare: () => ({}) },
  SPRIGR_PLATFORM_BASE: BASE,
  SPRIGR_INSTALL_TOKEN: TOKEN,
  INSTALL_ID: 'inst_abc',
  ...over,
});

const entry = (over: Partial<SprigrLogEntry> = {}): SprigrLogEntry => ({
  level: 'info',
  category: 'webhook.ok',
  summary: 'orders/create 6699',
  ...over,
});

describe('validateLogEntry', () => {
  it('accepts a full entry and returns a normalised copy without unknown keys', () => {
    const raw = {
      ...entry({ detail: 'd', metadata: { a: 1 }, agent_id: 'ag_1', trace_id: 'tr_1' }),
      stray: 'dropped',
    };
    const out = validateLogEntry(raw);
    expect(out).toEqual({
      level: 'info',
      category: 'webhook.ok',
      summary: 'orders/create 6699',
      detail: 'd',
      metadata: { a: 1 },
      agent_id: 'ag_1',
      trace_id: 'tr_1',
    });
    expect('stray' in out).toBe(false);
  });

  it('omits optional keys that were passed as undefined', () => {
    const out = validateLogEntry(entry({ detail: undefined, metadata: undefined }));
    expect(Object.keys(out)).toEqual(['level', 'category', 'summary']);
  });

  it('rejects a non-object entry', () => {
    expect(() => validateLogEntry('nope', 3)).toThrow(/entries\[3\] must be an object/);
    expect(() => validateLogEntry(['a'])).toThrow(SprigrLogValidationError);
  });

  it('rejects an unknown level', () => {
    expect(() => validateLogEntry(entry({ level: 'fatal' as never }))).toThrow(/level must be one of/);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['with a space', 'web hook'],
    ['with a slash', 'orders/create'],
    ['leading dot', '.hidden'],
  ])('rejects a category that is %s', (_label, category) => {
    let err: unknown;
    try {
      validateLogEntry(entry({ category: category as never }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SprigrLogValidationError);
    expect((err as SprigrLogValidationError).field).toBe('category');
  });

  it('accepts every category character class the platform accepts', () => {
    expect(validateLogEntry(entry({ category: 'A9._:-z' })).category).toBe('A9._:-z');
  });

  it('caps category at 64 chars and names the cap', () => {
    let err: SprigrLogValidationError | undefined;
    try {
      validateLogEntry(entry({ category: 'a'.repeat(65) }), 2);
    } catch (e) {
      err = e as SprigrLogValidationError;
    }
    expect(err?.field).toBe('category');
    expect(err?.max).toBe(SPRIGR_LOG_LIMITS.maxCategoryChars);
    expect(err?.length).toBe(65);
    expect(err?.index).toBe(2);
  });

  it('requires a summary and caps it at 256 chars without truncating', () => {
    expect(() => validateLogEntry(entry({ summary: '' }))).toThrow(/summary required/);
    const long = 'x'.repeat(257);
    let err: SprigrLogValidationError | undefined;
    try {
      validateLogEntry(entry({ summary: long }));
    } catch (e) {
      err = e as SprigrLogValidationError;
    }
    expect(err?.message).toMatch(/summary is 257 chars; max 256/);
    expect(err?.message).toMatch(/never truncates/);
    // Exactly at the cap passes untouched.
    expect(validateLogEntry(entry({ summary: 'x'.repeat(256) })).summary).toHaveLength(256);
  });

  it('caps detail at 4096 chars and rejects a non-string detail', () => {
    expect(validateLogEntry(entry({ detail: 'y'.repeat(4096) })).detail).toHaveLength(4096);
    expect(() => validateLogEntry(entry({ detail: 'y'.repeat(4097) }))).toThrow(/detail is 4097 chars; max 4096/);
    expect(() => validateLogEntry(entry({ detail: 42 as never }))).toThrow(/detail must be a string/);
  });

  it('caps metadata by its JSON length at 3840 and rejects arrays', () => {
    const fits = { k: 'v'.repeat(3840 - '{"k":""}'.length) };
    expect(JSON.stringify(fits)).toHaveLength(3840);
    expect(validateLogEntry(entry({ metadata: fits })).metadata).toEqual(fits);
    const over = { k: 'v'.repeat(3840 - '{"k":""}'.length + 1) };
    let err: SprigrLogValidationError | undefined;
    try {
      validateLogEntry(entry({ metadata: over }));
    } catch (e) {
      err = e as SprigrLogValidationError;
    }
    expect(err?.field).toBe('metadata');
    expect(err?.length).toBe(3841);
    expect(err?.max).toBe(3840);
    expect(() => validateLogEntry(entry({ metadata: [] as never }))).toThrow(/metadata must be a plain object/);
  });

  it.each(['agent_id', 'trace_id'] as const)('bounds %s to a non-empty string of at most 128 chars', (field) => {
    expect(validateLogEntry(entry({ [field]: 'a'.repeat(128) }))[field]).toHaveLength(128);
    expect(() => validateLogEntry(entry({ [field]: '' }))).toThrow(new RegExp(`${field} must be a non-empty string`));
    expect(() => validateLogEntry(entry({ [field]: 'a'.repeat(129) }))).toThrow(SprigrLogValidationError);
    expect(() => validateLogEntry(entry({ [field]: 7 as never }))).toThrow(SprigrLogValidationError);
  });
});

describe('validateLogEntries', () => {
  it('wraps a single entry into a one-element array', () => {
    expect(validateLogEntries(entry())).toEqual([entry()]);
  });

  it('rejects an empty batch', () => {
    expect(() => validateLogEntries([])).toThrow(/at least one entry required/);
  });

  it('accepts 50 entries and rejects 51, naming the count', () => {
    expect(validateLogEntries(Array.from({ length: 50 }, () => entry()))).toHaveLength(50);
    let err: SprigrLogValidationError | undefined;
    try {
      validateLogEntries(Array.from({ length: 51 }, () => entry()));
    } catch (e) {
      err = e as SprigrLogValidationError;
    }
    expect(err?.message).toMatch(/at most 50 entries per call \(got 51\)/);
    expect(err?.max).toBe(50);
    expect(err?.length).toBe(51);
  });

  it('one bad entry rejects the whole batch and names its index', () => {
    let err: SprigrLogValidationError | undefined;
    try {
      validateLogEntries([entry(), entry(), entry({ summary: '' })]);
    } catch (e) {
      err = e as SprigrLogValidationError;
    }
    expect(err?.index).toBe(2);
  });
});

describe('logToPlatform, inline route (no env.SPRIGR)', () => {
  it('posts { entries } to /internal/wfp/log with the install-token bearer', async () => {
    const r = await logToPlatform(inlineEnv(), entry({ metadata: { topic: 'orders/create' } }));
    expect(r).toEqual({ ok: true, written: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/internal/wfp/log`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({
      entries: [{ level: 'info', category: 'webhook.ok', summary: 'orders/create 6699', metadata: { topic: 'orders/create' } }],
    });
  });

  it('sends a batch as one call and reports the platform count', async () => {
    reply = { status: 200, body: { ok: true, written: 3 } };
    const r = await logToPlatform(inlineEnv(), [entry(), entry(), entry()]);
    expect(r).toEqual({ ok: true, written: 3 });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('throws synchronously on a cap violation and sends nothing', () => {
    expect(() => logToPlatform(inlineEnv(), entry({ summary: 'x'.repeat(300) }))).toThrow(
      SprigrLogValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it('reports a platform 400 without throwing, carrying the status and error code', async () => {
    reply = {
      status: 400,
      body: { error: 'summary_too_long', detail: 'entries[0].summary is 300 chars; max 256', index: 0, field: 'summary' },
    };
    const r = await logToPlatform(inlineEnv(), entry());
    expect(r).toEqual({
      ok: false,
      error: 'summary_too_long',
      status: 400,
      detail: 'entries[0].summary is 300 chars; max 256',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports 401 and 404 as non-throwing failures', async () => {
    reply = { status: 401, body: { error: 'unauthorized', detail: 'invalid install token' } };
    let r = await logToPlatform(inlineEnv(), entry());
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(401);
    reply = { status: 404, body: { error: 'install_not_found_or_inactive' } };
    r = await logToPlatform(inlineEnv(), entry());
    expect(r).toMatchObject({ ok: false, error: 'install_not_found_or_inactive', status: 404 });
  });

  it('reports a transport failure without throwing', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof globalThis.fetch;
    const r = await logToPlatform(inlineEnv(), entry());
    expect(r).toMatchObject({ ok: false, error: 'log_transport_failed' });
    expect((r as { detail?: string }).detail).toContain('network down');
  });

  it('treats an empty 2xx body as written', async () => {
    reply = { status: 200, body: '' };
    const r = await logToPlatform(inlineEnv(), [entry(), entry()]);
    expect(r).toEqual({ ok: true, written: 2 });
  });

  it('names which binding is missing when there is no log path at all', async () => {
    const r = await logToPlatform({ DB: {} }, entry());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('no_log_path');
    expect((r as { detail?: string }).detail).toContain('SPRIGR_PLATFORM_BASE=unset');
    expect((r as { detail?: string }).detail).toContain('SPRIGR_INSTALL_TOKEN=unset');
    expect(calls).toHaveLength(0);
  });

  it('has no production default (a staging install must never log into prod)', async () => {
    const r = await logToPlatform({ SPRIGR_INSTALL_TOKEN: TOKEN }, entry());
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('registers the send with waitUntil when given one', async () => {
    const registered: Promise<unknown>[] = [];
    const p = logToPlatform(inlineEnv(), entry(), { waitUntil: (x) => registered.push(x) });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(p);
    await p;
  });

  it('aborts a hung platform call instead of holding the handler', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof globalThis.fetch;
    const r = await logToPlatform(inlineEnv(), entry(), { timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect((r as { detail?: string }).detail).toContain('aborted');
  });
});

describe('logToPlatform, dispatch path (env.SPRIGR present)', () => {
  it('prefers the injected binding and makes no HTTP call', async () => {
    const seen: unknown[] = [];
    const env = inlineEnv({
      SPRIGR: {
        log: async (input: unknown) => {
          seen.push(input);
          return { ok: true, written: 1 };
        },
      },
    });
    const r = await logToPlatform(env, entry());
    expect(r).toEqual({ ok: true, written: 1 });
    expect(calls).toHaveLength(0);
    // Always hands the host an array of validated entries.
    expect(seen).toEqual([[entry()]]);
  });

  it('folds a synchronously throwing binding into a failed result', async () => {
    const env = inlineEnv({
      SPRIGR: {
        log: () => {
          throw new Error('env.SPRIGR.log: marketplace bindings not configured for this install');
        },
      },
    });
    const r = await logToPlatform(env, entry());
    expect(r).toMatchObject({ ok: false, error: 'log_failed' });
    expect((r as { detail?: string }).detail).toContain('not configured');
  });

  it('folds a rejecting binding into a failed result', async () => {
    const env = inlineEnv({ SPRIGR: { log: async () => Promise.reject(new Error('boom')) } });
    const r = await logToPlatform(env, entry());
    expect(r).toMatchObject({ ok: false, error: 'log_failed', detail: 'boom' });
  });

  it('falls back to HTTP when SPRIGR exists but has no log (older wrapper build)', async () => {
    const env = inlineEnv({ SPRIGR: { emit: async () => ({ ok: true }) } });
    const r = await logToPlatform(env, entry());
    expect(r).toEqual({ ok: true, written: 1 });
    expect(calls).toHaveLength(1);
  });
});

describe('withSprigrLogFallback', () => {
  it('installs a working log on an inline-route env', async () => {
    const env = withSprigrLogFallback(inlineEnv()) as unknown as {
      SPRIGR: { log: (e: unknown) => Promise<unknown> };
    };
    const r = await env.SPRIGR.log(entry());
    expect(r).toEqual({ ok: true, written: 1 });
    expect(calls[0]!.url).toBe(`${BASE}/internal/wfp/log`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps DB reachable (regression: spread-built envs lost it)', () => {
    const env = withSprigrLogFallback(inlineEnv());
    expect(typeof (env as { DB: { prepare: unknown } }).DB.prepare).toBe('function');
  });

  it('matches the host contract: throws synchronously on a bad entry, never rejects after', async () => {
    const env = withSprigrLogFallback(inlineEnv()) as unknown as {
      SPRIGR: { log: (e: unknown) => Promise<unknown> };
    };
    expect(() => env.SPRIGR.log(entry({ category: 'has space' }))).toThrow(SprigrLogValidationError);
    reply = { status: 500, body: { error: 'ae_unavailable' } };
    await expect(env.SPRIGR.log(entry())).resolves.toMatchObject({ ok: false, error: 'ae_unavailable', status: 500 });
  });

  it('returns the env untouched when the binding already works', () => {
    const env = inlineEnv({ SPRIGR: { log: async () => ({ ok: true, written: 1 }) } });
    expect(withSprigrLogFallback(env)).toBe(env);
  });

  it('returns the env untouched when there are no bindings to build from', () => {
    const env = { DB: {} };
    expect(withSprigrLogFallback(env)).toBe(env);
  });

  it('preserves sibling namespaces already on SPRIGR', async () => {
    const emit = async () => ({ ok: true, eventId: 'e1' });
    const env = withSprigrLogFallback(inlineEnv({ SPRIGR: { emit } })) as unknown as {
      SPRIGR: { emit: typeof emit; log: unknown };
    };
    expect(env.SPRIGR.emit).toBe(emit);
    expect(typeof env.SPRIGR.log).toBe('function');
  });

  it('hands every send to waitUntil when configured', async () => {
    const registered: Promise<unknown>[] = [];
    const env = withSprigrLogFallback(inlineEnv(), { waitUntil: (p) => registered.push(p) }) as unknown as {
      SPRIGR: { log: (e: unknown) => Promise<unknown> };
    };
    const p = env.SPRIGR.log(entry());
    expect(registered).toEqual([p]);
    await p;
  });
});

describe('canLog', () => {
  it('is true when the binding is present', () => {
    expect(canLog({ SPRIGR: { log: () => Promise.resolve({ ok: true, written: 0 }) } })).toBe(true);
  });

  it('is true on an inline route, where only the bridge exists', () => {
    expect(canLog(inlineEnv())).toBe(true);
  });

  it('is false when neither transport is available', () => {
    expect(canLog({ DB: {} })).toBe(false);
    expect(canLog({ SPRIGR: { emit: () => {} } })).toBe(false);
  });
});

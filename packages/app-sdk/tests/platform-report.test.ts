import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  reportToPlatform,
  canReport,
  SPRIGR_REPORT_LIMITS,
  SPRIGR_REPORT_SEVERITIES,
  type SprigrReportFn,
  type SprigrReportInput,
  type SprigrReportResult,
} from '../src/platform-report';
import * as sdk from '../src/index';

const BASE = 'https://staging-webhooks.sprigr.com';
const TOKEN = 'inst_abc.c2lnbmF0dXJl';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, status: 'filed' } };
let originalFetch: typeof globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { ok: true, status: 'filed' } };
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)),
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  warn.mockRestore();
});

const bridgeEnv = () => ({ SPRIGR_PLATFORM_BASE: BASE, SPRIGR_INSTALL_TOKEN: TOKEN });
const input: SprigrReportInput = { key: 'skip_empty_with_rows', title: 'Skipped an empty batch that had rows' };

describe('SPRIGR_REPORT_LIMITS', () => {
  it('mirrors the platform route (sprigr-team workers/provisioning/src/wfp-report.ts)', () => {
    expect(SPRIGR_REPORT_LIMITS.keyPattern.source).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(SPRIGR_REPORT_LIMITS.maxTitleChars).toBe(200);
    expect(SPRIGR_REPORT_LIMITS.maxDetailChars).toBe(8000);
    expect(SPRIGR_REPORT_LIMITS.defaultTtlSeconds).toBe(86400);
    expect(SPRIGR_REPORT_LIMITS.minTtlSeconds).toBe(3600);
    expect(SPRIGR_REPORT_LIMITS.maxTtlSeconds).toBe(604800);
    expect(SPRIGR_REPORT_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

describe('reportToPlatform', () => {
  it('prefers the injected env.SPRIGR.report and returns its result', async () => {
    const report = vi.fn<SprigrReportFn>(async () => ({ ok: true, status: 'deduped' }));
    const res = await reportToPlatform({ SPRIGR: { report }, ...bridgeEnv() }, input);
    expect(res).toEqual({ ok: true, status: 'deduped' });
    expect(report).toHaveBeenCalledWith(input);
    expect(calls).toHaveLength(0);
  });

  it('folds a host member that throws or rejects into a failed result', async () => {
    const throwing = (() => {
      throw new Error('boom');
    }) as unknown as SprigrReportFn;
    const rejecting = (async () => {
      throw new Error('nope');
    }) as SprigrReportFn;
    await expect(reportToPlatform({ SPRIGR: { report: throwing } }, input)).resolves.toEqual({
      ok: false,
      error: 'report_failed',
      detail: 'boom',
    });
    await expect(reportToPlatform({ SPRIGR: { report: rejecting } }, input)).resolves.toEqual({
      ok: false,
      error: 'report_failed',
      detail: 'nope',
    });
  });

  it('falls back to POST /internal/wfp/report with the install bearer', async () => {
    const res = await reportToPlatform(bridgeEnv(), { ...input, severity: 'critical', ttlSeconds: 7200 });
    expect(res).toEqual({ ok: true, status: 'filed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/internal/wfp/report`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ ...input, severity: 'critical', ttlSeconds: 7200 });
  });

  it.each(['deduped', 'rate_limited'] as const)('passes the platform %s outcome through', async (status) => {
    reply = { status: 200, body: { ok: true, status } };
    await expect(reportToPlatform(bridgeEnv(), input)).resolves.toEqual({ ok: true, status });
  });

  it('passes a platform-side failed filing through', async () => {
    reply = { status: 200, body: { ok: false, status: 'failed' } };
    await expect(reportToPlatform(bridgeEnv(), input)).resolves.toEqual({ ok: false, status: 'failed' });
  });

  it('resolves a refused call with the route error, never rejecting', async () => {
    reply = { status: 400, body: { ok: false, error: 'title_too_long', detail: 'title is 300 chars; max 200.' } };
    const res = await reportToPlatform(bridgeEnv(), { ...input, title: 'x'.repeat(300) });
    expect(res).toEqual({ ok: false, error: 'title_too_long', status: 400, detail: 'title is 300 chars; max 200.' });
  });

  it('resolves a transport failure without rejecting', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;
    const res = await reportToPlatform(bridgeEnv(), input);
    expect(res).toMatchObject({ ok: false, error: 'report_transport_failed', detail: 'network down' });
  });

  it('resolves bindings_not_configured when neither transport exists', async () => {
    const res = await reportToPlatform({}, input);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, error: 'bindings_not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('hands the pending result to waitUntil', async () => {
    const waitUntil = vi.fn();
    const p = reportToPlatform(bridgeEnv(), input, { waitUntil });
    expect(waitUntil).toHaveBeenCalledWith(p);
    await p;
  });
});

describe('canReport', () => {
  it('is true with either transport and false with none', () => {
    expect(canReport({ SPRIGR: { report: async () => ({ ok: true, status: 'filed' }) } })).toBe(true);
    expect(canReport(bridgeEnv())).toBe(true);
    expect(canReport({})).toBe(false);
  });
});

describe('package exports', () => {
  it('re-exports the report helpers from the package root', () => {
    expect(sdk.reportToPlatform).toBe(reportToPlatform);
    expect(sdk.canReport).toBe(canReport);
    expect(sdk.SPRIGR_REPORT_LIMITS).toBe(SPRIGR_REPORT_LIMITS);
  });

  it('types the result union so a caller narrows on ok and status', () => {
    const narrow = (r: SprigrReportResult): string =>
      r.ok ? r.status : 'error' in r ? r.error : r.status;
    expect(narrow({ ok: true, status: 'filed' })).toBe('filed');
    expect(narrow({ ok: false, status: 'failed' })).toBe('failed');
    expect(narrow({ ok: false, error: 'home_read_only' })).toBe('home_read_only');
  });
});

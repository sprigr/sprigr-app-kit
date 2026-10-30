/**
 * `env.SPRIGR.report`: an app files a deduped platform report about a problem
 * it found (sprigr-team decision 0262, sprigr-team#12208). The platform route
 * is `POST /internal/wfp/report`; it stamps the app, install, installing
 * company and publisher, scrubs credentials from title and detail, dedupes one
 * report per app + key per window, caps new filings (5 per install per day,
 * 20 per app per hour), and files severity 'critical' as 'high'.
 *
 * This module carries:
 *   1. The types of the host member, so a call site is typed.
 *   2. The route's limits, so an app can shape its input before calling.
 *   3. The inline-route fallback (`reportToPlatform`), for code that runs
 *      where the host member is absent (an inline Next route).
 *
 * Unlike `env.SPRIGR.log`, the host member does NOT validate client-side and
 * NEVER throws or rejects: a refused call resolves `{ ok: false, error }`
 * with the route's error code. `reportToPlatform` keeps that contract.
 */

import {
  describeMissingBridge,
  installTokenPost,
  resolveInstallBridge,
  type WfpBridgeEnv,
} from './wfp-bridge';

/** Requested severity. The platform files 'critical' as 'high'. */
export type SprigrReportSeverity = 'low' | 'medium' | 'high' | 'critical';

export const SPRIGR_REPORT_SEVERITIES: readonly SprigrReportSeverity[] = ['low', 'medium', 'high', 'critical'];

export interface SprigrReportInput {
  /** Stable identifier for this problem, e.g. "skip_empty_with_rows". Dedupe key per app. */
  key: string;
  /** One line, at most 200 chars. */
  title: string;
  /** Optional detail, at most 8000 chars. */
  detail?: string;
  /** Default 'medium'. */
  severity?: SprigrReportSeverity;
  /** Dedupe window in seconds. Default 86400, clamped to 3600..604800. */
  ttlSeconds?: number;
}

/**
 * What the host member resolves. It never rejects.
 * - `{ ok: true, status }`: filed, deduped (already filed in this window), or
 *   rate_limited (a cap was reached; nothing filed).
 * - `{ ok: false, status: 'failed' }`: the platform accepted the call but the
 *   filing itself failed.
 * - `{ ok: false, error }`: refused (`invalid_key`, `title_too_long`, ...),
 *   a transport failure, `bindings_not_configured`, or `home_read_only` on a
 *   Home dispatch.
 */
export type SprigrReportResult =
  | { ok: true; status: 'filed' | 'deduped' | 'rate_limited' }
  | { ok: false; status: 'failed' }
  | { ok: false; error: string; detail?: string; status?: number };

/** Signature of the injected `env.SPRIGR.report`. */
export type SprigrReportFn = (input: SprigrReportInput) => Promise<SprigrReportResult>;

/** Mirrors the platform route (sprigr-team `workers/provisioning/src/wfp-report.ts`). */
export const SPRIGR_REPORT_LIMITS = Object.freeze({
  keyPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  maxTitleChars: 200,
  maxDetailChars: 8000,
  defaultTtlSeconds: 24 * 3600,
  minTtlSeconds: 3600,
  maxTtlSeconds: 7 * 24 * 3600,
  capPerInstallPerDay: 5,
  capPerAppPerHour: 20,
});

export const DEFAULT_REPORT_TIMEOUT_MS = 5_000;

export interface ReportToPlatformOptions {
  /** Override the 5s ceiling on the HTTP fallback. */
  timeoutMs?: number;
  /** `ctx.waitUntil` from the route handler, so the fallback fetch outlives the response. */
  waitUntil?: (p: Promise<unknown>) => void;
}

function bindingReport(env: WfpBridgeEnv): SprigrReportFn | null {
  const sprigr = env.SPRIGR as { report?: unknown } | undefined;
  return typeof sprigr?.report === 'function' ? (sprigr.report as SprigrReportFn).bind(sprigr) : null;
}

/** Whether a report could reach the platform by either transport. */
export function canReport(env: WfpBridgeEnv): boolean {
  return bindingReport(env) !== null || resolveInstallBridge(env) !== null;
}

function failed(err: unknown): SprigrReportResult {
  return { ok: false, error: 'report_failed', detail: err instanceof Error ? err.message : String(err) };
}

async function postReport(env: WfpBridgeEnv, input: SprigrReportInput, timeoutMs: number): Promise<SprigrReportResult> {
  const bridge = resolveInstallBridge(env);
  if (!bridge) {
    return { ok: false, error: 'bindings_not_configured', detail: describeMissingBridge(env) };
  }
  try {
    const reply = await installTokenPost(bridge, '/internal/wfp/report', input ?? {}, { label: 'report', timeoutMs });
    if (reply.ok === true && (reply.status === 'filed' || reply.status === 'deduped' || reply.status === 'rate_limited')) {
      return { ok: true, status: reply.status };
    }
    if (reply.ok === false && reply.status === 'failed') return { ok: false, status: 'failed' };
    return {
      ok: false,
      error: typeof reply.error === 'string' ? reply.error : 'report_failed',
      ...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}),
    };
  } catch (err) {
    const e = err as Error & { status?: number; error?: string; detail?: string };
    const message = e instanceof Error ? e.message : String(err);
    console.warn(`[sprigr-report] report fallback failed: ${message}`);
    return {
      ok: false,
      error: e.error ?? (e.status !== undefined ? 'report_failed' : 'report_transport_failed'),
      ...(e.status !== undefined ? { status: e.status } : {}),
      detail: e.detail ?? message,
    };
  }
}

/**
 * File a platform report from any execution context. Prefers the injected
 * `env.SPRIGR.report`; falls back to the install-token bridge when it is
 * absent. Never throws and never rejects.
 *
 *   const r = await reportToPlatform(env, {
 *     key: 'skip_empty_with_rows',
 *     title: 'Upstream returned rows on a page marked empty',
 *     detail: `page ${page}, ${rows.length} rows`,
 *   }, { waitUntil: ctx.waitUntil.bind(ctx) });
 */
export function reportToPlatform(
  env: WfpBridgeEnv,
  input: SprigrReportInput,
  opts?: ReportToPlatformOptions,
): Promise<SprigrReportResult> {
  const injected = bindingReport(env);
  let result: Promise<SprigrReportResult>;
  if (injected) {
    try {
      result = Promise.resolve(injected(input)).catch(failed);
    } catch (err) {
      result = Promise.resolve(failed(err));
    }
  } else {
    result = postReport(env, input, opts?.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS);
  }
  if (opts?.waitUntil) opts.waitUntil(result);
  return result;
}

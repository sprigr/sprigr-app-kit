/**
 * `env.SPRIGR.log`: durable app logging without a D1 audit table.
 *
 * The platform (sprigr-team#7154) exposes `env.SPRIGR.log(entry | entry[])`
 * on every `/__sprigr/*` dispatch path. Each entry becomes one row in the
 * platform's `system_logs` Analytics Engine dataset: 90-day retention,
 * scoped to the install's company, `source = 'install'`, category prefixed
 * with the app slug, metadata stamped with `app_slug` + `install_id`.
 *
 * Use it for every "we saw X" line a webhook, schedule tick, poll or tool
 * call used to write into the app's own D1 as an audit row. D1 bills each
 * row written (plus one per index), so a row per delivery is the largest
 * D1 line item an app can produce (sprigr-apps#1519: one Shopify install
 * wrote ~1.7M audit + dedup rows a day). AE has no per-row write bill.
 *
 * This module carries three things:
 *
 *   1. The TYPES of the host member (`SprigrLogEntry`, `SprigrLogFn`), so an
 *      app's env interface can declare `log` on its `SPRIGR` type.
 *   2. `validateLogEntries`, a byte-for-byte mirror of the caps the host
 *      member and the platform route enforce. Caps are REJECTIONS, never
 *      truncation: an oversize entry throws before anything is sent.
 *   3. The inline-route fallback (`logToPlatform`, `withSprigrLogFallback`).
 *      Inline Next.js route handlers never receive `env.SPRIGR`, so an app
 *      whose provider webhook lands on one has no `log` there. Same escape
 *      hatch as `emitMarketplaceEvent`: `POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/log`
 *      with the `SPRIGR_INSTALL_TOKEN` bearer and `{ entries: [...] }`.
 *
 * Wire contract (workers/provisioning/src/wfp-log.ts in sprigr-team):
 *   200 { ok: true, written }
 *   400 { error, detail, index, field, max?, length? } with error one of
 *       summary_too_long, detail_too_long, metadata_too_large,
 *       too_many_entries, invalid_category, invalid_level, ...
 *   413 body_too_large (over 512 KiB)
 *   401 / 404 bad token / inactive install
 */

import {
  describeMissingBridge,
  installTokenPost,
  overlaySprigr,
  resolveInstallBridge,
  type WfpBridgeEnv,
} from './wfp-bridge';

/** Severity of one log row. Maps onto `system_logs.level`. */
export type SprigrLogLevel = 'debug' | 'info' | 'warn' | 'error';

export const SPRIGR_LOG_LEVELS: readonly SprigrLogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * One row for `env.SPRIGR.log`. Every string cap is enforced client-side
 * (throw) AND platform-side (400); nothing is ever truncated.
 */
export interface SprigrLogEntry {
  /** Required. */
  level: SprigrLogLevel;
  /**
   * Required. 1-64 chars of `[A-Za-z0-9._:-]`, first char alphanumeric. The
   * platform stores it as `<app_slug>.<category>` and it is the exact-match
   * filter key when reading rows back, so make it a stable outcome name
   * (`webhook.ok`, `webhook.duplicate`, `sync.tick`) and put the varying
   * parts (topic, ids) in `metadata`.
   */
  category: string;
  /** Required. 1-256 chars. One line a human can scan in a log viewer. */
  summary: string;
  /** Optional, at most 4096 chars. Reserve it for error text; bulk goes in `metadata`. */
  detail?: string;
  /** Optional plain object whose `JSON.stringify` is at most 3840 chars.
   *  The platform merges `{ app_slug, install_id }` over it (platform keys win). */
  metadata?: Record<string, unknown>;
  /** Optional, at most 128 chars. Defaults on the dispatch path to the
   *  dispatching actor's agent id. */
  agent_id?: string;
  /** Optional, at most 128 chars. Defaults on the platform to the ambient request trace. */
  trace_id?: string;
}

/**
 * What `env.SPRIGR.log` resolves to. The promise NEVER rejects: transport
 * and platform failures come back as `{ ok: false }` (and a console.warn).
 * Only a cap or shape violation throws, synchronously, before sending.
 */
export type SprigrLogResult =
  | { ok: true; written: number }
  | { ok: false; error: string; status?: number; detail?: string };

/**
 * The host member's signature. Declare it on your app's `SPRIGR` env type:
 *
 *   interface MyEnv { SPRIGR?: { emit: ...; log?: SprigrLogFn } }
 *
 * Mark it optional: wrapper builds older than sprigr-team#7154 do not carry
 * it, and `logToPlatform` degrades cleanly when it is absent.
 */
export type SprigrLogFn = (input: SprigrLogEntry | SprigrLogEntry[]) => Promise<SprigrLogResult>;

/**
 * The caps, verbatim from the platform route (`WFP_LOG_*` in
 * workers/provisioning/src/wfp-log.ts) and the wrapper's `log` member. The
 * platform's 400 body echoes its live cap, so a mismatch here is
 * self-describing rather than silent.
 */
export const SPRIGR_LOG_LIMITS = Object.freeze({
  maxEntriesPerCall: 50,
  maxCategoryChars: 64,
  categoryPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  maxSummaryChars: 256,
  maxDetailChars: 4096,
  /** 4096-char metadata blob minus the platform's 256-char reserve for
   *  `app_slug` + `install_id`. */
  maxMetadataChars: 3840,
  maxIdChars: 128,
});

/** Same 5s ceiling as the emit fallback: a webhook ack matters more than a log row. */
export const DEFAULT_LOG_TIMEOUT_MS = 5_000;

/**
 * Thrown by `validateLogEntries` (and therefore by `logToPlatform` and the
 * fallback `log`) before anything is sent. Carries the same fields as the
 * platform's 400 body so a caller can log or branch on them.
 */
export class SprigrLogValidationError extends Error {
  readonly index: number;
  readonly field: string;
  readonly max?: number;
  readonly length?: number;

  constructor(
    message: string,
    fields: { index: number; field: string; max?: number; length?: number },
  ) {
    super(message);
    this.name = 'SprigrLogValidationError';
    this.index = fields.index;
    this.field = fields.field;
    if (fields.max !== undefined) this.max = fields.max;
    if (fields.length !== undefined) this.length = fields.length;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tooLong(index: number, field: string, length: number, max: number): SprigrLogValidationError {
  return new SprigrLogValidationError(
    `env.SPRIGR.log: entries[${index}].${field} is ${length} chars; max ${max}. Nothing was sent; the platform never truncates a log field. Move the long part into detail or metadata, or split it across rows.`,
    { index, field, max, length },
  );
}

/**
 * Validate one entry against the platform caps. Returns a fresh, normalised
 * copy (unknown keys dropped, `undefined` optionals omitted) or throws
 * `SprigrLogValidationError`. Pure; `index` only labels the error.
 */
export function validateLogEntry(raw: unknown, index = 0): SprigrLogEntry {
  const at = `env.SPRIGR.log: entries[${index}]`;
  if (!isPlainObject(raw)) {
    throw new SprigrLogValidationError(`${at} must be an object`, { index, field: 'entry' });
  }
  const L = SPRIGR_LOG_LIMITS;

  const level = raw.level;
  if (typeof level !== 'string' || !(SPRIGR_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new SprigrLogValidationError(`${at}.level must be one of ${SPRIGR_LOG_LEVELS.join(' | ')}`, {
      index,
      field: 'level',
    });
  }

  const category = raw.category;
  if (typeof category !== 'string' || category.length === 0) {
    throw new SprigrLogValidationError(`${at}.category required (string)`, { index, field: 'category' });
  }
  if (category.length > L.maxCategoryChars) throw tooLong(index, 'category', category.length, L.maxCategoryChars);
  if (!L.categoryPattern.test(category)) {
    throw new SprigrLogValidationError(
      `${at}.category must match ${L.categoryPattern} (letters, digits, . _ : -; no spaces)`,
      { index, field: 'category' },
    );
  }

  const summary = raw.summary;
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new SprigrLogValidationError(`${at}.summary required (string)`, { index, field: 'summary' });
  }
  if (summary.length > L.maxSummaryChars) throw tooLong(index, 'summary', summary.length, L.maxSummaryChars);

  const out: SprigrLogEntry = { level: level as SprigrLogLevel, category, summary };

  if (raw.detail !== undefined) {
    if (typeof raw.detail !== 'string') {
      throw new SprigrLogValidationError(`${at}.detail must be a string`, { index, field: 'detail' });
    }
    if (raw.detail.length > L.maxDetailChars) throw tooLong(index, 'detail', raw.detail.length, L.maxDetailChars);
    out.detail = raw.detail;
  }

  if (raw.metadata !== undefined) {
    if (!isPlainObject(raw.metadata)) {
      throw new SprigrLogValidationError(`${at}.metadata must be a plain object`, { index, field: 'metadata' });
    }
    const serialised = JSON.stringify(raw.metadata).length;
    if (serialised > L.maxMetadataChars) {
      throw new SprigrLogValidationError(
        `${at}.metadata JSON is ${serialised} chars; max ${L.maxMetadataChars}. Nothing was sent; drop or split fields.`,
        { index, field: 'metadata', max: L.maxMetadataChars, length: serialised },
      );
    }
    out.metadata = raw.metadata;
  }

  for (const field of ['agent_id', 'trace_id'] as const) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > L.maxIdChars) {
      throw new SprigrLogValidationError(
        `${at}.${field} must be a non-empty string of at most ${L.maxIdChars} chars`,
        { index, field, max: L.maxIdChars, length: typeof v === 'string' ? v.length : undefined },
      );
    }
    out[field] = v;
  }
  return out;
}

/**
 * Normalise `entry | entry[]` to a validated array, or throw. One bad entry
 * rejects the whole batch, matching the platform's all-or-nothing write.
 */
export function validateLogEntries(input: unknown): SprigrLogEntry[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) {
    throw new SprigrLogValidationError('env.SPRIGR.log: at least one entry required', {
      index: 0,
      field: 'entries',
    });
  }
  if (list.length > SPRIGR_LOG_LIMITS.maxEntriesPerCall) {
    throw new SprigrLogValidationError(
      `env.SPRIGR.log: at most ${SPRIGR_LOG_LIMITS.maxEntriesPerCall} entries per call (got ${list.length}); nothing was sent`,
      {
        index: 0,
        field: 'entries',
        max: SPRIGR_LOG_LIMITS.maxEntriesPerCall,
        length: list.length,
      },
    );
  }
  return list.map((e, i) => validateLogEntry(e, i));
}

/** Narrow an unknown `env.SPRIGR` down to a callable `log`. */
function bindingLog(env: WfpBridgeEnv): SprigrLogFn | null {
  const sprigr = env.SPRIGR as { log?: unknown } | undefined;
  return typeof sprigr?.log === 'function' ? (sprigr.log as SprigrLogFn).bind(sprigr) : null;
}

export interface LogToPlatformOptions {
  /** Override the 5s ceiling on the HTTP fallback. */
  timeoutMs?: number;
  /**
   * `ctx.waitUntil` from the route handler. On the HTTP fallback the row
   * is only guaranteed to land if the fetch outlives the response, which
   * on an inline route means registering it here. The injected host member
   * does this on its own; the fallback cannot see `ctx`, so hand it over.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Reply shape of `/internal/wfp/log`. */
interface WfpLogReply {
  ok?: boolean;
  written?: number;
  error?: string;
  detail?: string;
}

/**
 * Whether a log row could reach the platform at all, by either transport.
 * Gate work whose only purpose is to build a log entry on this, not on
 * `env.SPRIGR?.log`, which is absent on every inline route.
 */
export function canLog(env: WfpBridgeEnv): boolean {
  return bindingLog(env) !== null || resolveInstallBridge(env) !== null;
}

async function postLog(
  env: WfpBridgeEnv,
  entries: SprigrLogEntry[],
  timeoutMs: number,
): Promise<SprigrLogResult> {
  const bridge = resolveInstallBridge(env);
  if (!bridge) {
    return { ok: false, error: 'no_log_path', detail: describeMissingBridge(env) };
  }
  try {
    const reply = (await installTokenPost(bridge, '/internal/wfp/log', { entries }, {
      label: 'log',
      timeoutMs,
    })) as WfpLogReply;
    if (reply.ok === false) {
      return { ok: false, error: reply.error ?? 'log_failed', detail: reply.detail };
    }
    return { ok: true, written: typeof reply.written === 'number' ? reply.written : entries.length };
  } catch (err) {
    const e = err as Error & { status?: number; error?: string; detail?: string };
    const message = e instanceof Error ? e.message : String(err);
    console.warn(`[sprigr-log] log fallback failed: ${message}`);
    return {
      ok: false,
      error: e.error ?? (e.status !== undefined ? 'log_failed' : 'log_transport_failed'),
      ...(e.status !== undefined ? { status: e.status } : {}),
      detail: e.detail ?? message,
    };
  }
}

/**
 * Write log rows from any execution context.
 *
 * Prefers the injected `env.SPRIGR.log`; falls back to the install-token
 * bridge when it is absent (an inline Next route). Validation runs first
 * and THROWS on a cap or shape violation, exactly like the host member, so
 * a bad entry is caught at the call site. Everything after validation is
 * reported in the result, never raised: a webhook ack is never at risk.
 *
 *   await logToPlatform(env, {
 *     level: 'info', category: 'webhook.ok', summary: 'orders/create 6699',
 *     metadata: { topic: 'orders/create', resource_id: '6699' },
 *   }, { waitUntil: ctx.waitUntil.bind(ctx) });
 */
export function logToPlatform(
  env: WfpBridgeEnv,
  input: SprigrLogEntry | SprigrLogEntry[],
  opts?: LogToPlatformOptions,
): Promise<SprigrLogResult> {
  const entries = validateLogEntries(input);

  const injected = bindingLog(env);
  let result: Promise<SprigrLogResult>;
  if (injected) {
    // The host member throws synchronously when the install's bindings are
    // missing and its promise never rejects; fold the first into the second
    // so callers see one shape.
    try {
      result = Promise.resolve(injected(entries)).catch((err: unknown) => ({
        ok: false as const,
        error: 'log_failed',
        detail: err instanceof Error ? err.message : String(err),
      }));
    } catch (err) {
      result = Promise.resolve({
        ok: false,
        error: 'log_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    result = postLog(env, entries, opts?.timeoutMs ?? DEFAULT_LOG_TIMEOUT_MS);
  }
  if (opts?.waitUntil) opts.waitUntil(result);
  return result;
}

/**
 * Return an env whose `SPRIGR.log` works even on an inline route, leaving
 * existing `env.SPRIGR.log(...)` call sites untouched. Same shape as
 * `withSprigrEmitFallback`, and composable with it:
 *
 *   const env = withSprigrLogFallback(withSprigrEmitFallback(rawEnv), { waitUntil });
 *
 * The installed `log` matches the host member's contract: it throws
 * synchronously on a cap or shape violation and its promise never rejects.
 * When the bindings are absent the env is returned as-is (`SPRIGR.log`
 * stays undefined) so callers fail the same way they already do.
 */
export function withSprigrLogFallback<E extends WfpBridgeEnv & object>(
  env: E,
  opts?: LogToPlatformOptions,
): E {
  if (bindingLog(env)) return env;
  const bridge = resolveInstallBridge(env);
  if (!bridge) return env;

  const log: SprigrLogFn = (input) => {
    const entries = validateLogEntries(input);
    const p = postLog(env, entries, opts?.timeoutMs ?? DEFAULT_LOG_TIMEOUT_MS);
    if (opts?.waitUntil) opts.waitUntil(p);
    return p;
  };

  // Preserve any other namespaces already on SPRIGR (emit, data, store): we
  // are adding log, not replacing the host object.
  const existing = (env.SPRIGR ?? {}) as Record<string, unknown>;
  return overlaySprigr(env, { ...existing, log });
}

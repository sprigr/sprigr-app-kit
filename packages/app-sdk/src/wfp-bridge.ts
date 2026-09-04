/**
 * Talking to the platform from BOTH execution contexts.
 *
 * The marketplace runtime injects the `SPRIGR` host object **only on
 * `/__sprigr/*` dispatch paths** (tool, schedule, event and platform-webhook
 * handlers). Inline Next.js route handlers (`app/api/.../route.ts`) never
 * receive it. Any app whose provider webhook lands on an inline route (because
 * the provider doesn't HMAC bodies, so the marketplace dispatcher can't verify
 * the delivery) therefore has NO working `env.SPRIGR` on the one path that
 * matters most.
 *
 * An app that only tries `env.SPRIGR.emit` from there emits nothing at all,
 * silently, while still acking the provider 200. That has now shipped four
 * separate times (shopify #478, procore, starshipit, cin7-core), so the fix
 * lives here instead of being re-derived per app.
 *
 * The escape hatch: `SPRIGR_PLATFORM_BASE` and `SPRIGR_INSTALL_TOKEN` are plain
 * script vars stamped on every per-install WFP upload, so unlike `SPRIGR` they
 * ARE readable from an inline route. With them you can call the same
 * `/internal/wfp/*` endpoints the host object calls under the covers:
 *
 *   POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/emit
 *   Authorization: Bearer ${SPRIGR_INSTALL_TOKEN}
 *   { event, payload, sourceIntegration?, targetAppInstallationId?, dedupId? }
 *
 * Use `emitMarketplaceEvent` for a single call site, or `withSprigrEmitFallback`
 * to repair `env.SPRIGR.emit` once and leave existing call sites untouched.
 */

import type { MarketplaceEventEmitOpts } from './index';

/** Resolved per-install bridge credentials. */
export interface InstallBridge {
  /** Platform base, trailing slash stripped. */
  base: string;
  /** Per-install bearer, `<installId>.<base64url-hmac>`. */
  token: string;
}

/**
 * Minimal env shape these helpers read. Every app's own env interface
 * (ProcoreEnv, ShopifyEnv, ...) already satisfies it structurally, so passing
 * the full env is fine.
 */
export interface WfpBridgeEnv {
  SPRIGR?: unknown;
  SPRIGR_PLATFORM_BASE?: string;
  SPRIGR_INSTALL_TOKEN?: string;
  INSTALL_ID?: string;
  [key: string]: unknown;
}

/**
 * Pull the install-token bridge off env, or null when either half is missing.
 *
 * Deliberately has NO production default for the base: an app that guessed
 * `https://webhooks.sprigr.com` would have a *staging* install firing events
 * into *prod*, where the install id is unknown and the call 404s into a tail
 * nobody watching staging ever reads. Failing closed is louder.
 */
export function resolveInstallBridge(env: WfpBridgeEnv): InstallBridge | null {
  const token = typeof env.SPRIGR_INSTALL_TOKEN === 'string' ? env.SPRIGR_INSTALL_TOKEN : '';
  const base = typeof env.SPRIGR_PLATFORM_BASE === 'string' ? env.SPRIGR_PLATFORM_BASE.replace(/\/+$/, '') : '';
  if (!token || !base) return null;
  return { base, token };
}

/**
 * Human-readable note about which half of the bridge is missing. Which binding
 * is absent is the entire diagnosis, so never collapse this to a bare
 * "not configured".
 */
export function describeMissingBridge(env: WfpBridgeEnv): string {
  const base = typeof env.SPRIGR_PLATFORM_BASE === 'string' && env.SPRIGR_PLATFORM_BASE ? 'set' : 'unset';
  const token = typeof env.SPRIGR_INSTALL_TOKEN === 'string' && env.SPRIGR_INSTALL_TOKEN ? 'set' : 'unset';
  return `no_emit_path (SPRIGR unbound, SPRIGR_PLATFORM_BASE=${base}, SPRIGR_INSTALL_TOKEN=${token})`;
}

/**
 * Overlay a replacement `SPRIGR` onto env WITHOUT rebuilding it by spread.
 *
 * On the `/__sprigr/*` dispatch path the platform hands handlers
 * `Object.create(bindings)` with `SPRIGR` as a NON-ENUMERABLE own property: the
 * real bindings (`DB`, secrets, the install token itself) live on the
 * prototype. `{ ...env }` copies none of that — it yields an env whose `DB` is
 * undefined. That is exactly how every scheduled `ms_index_files` run died for
 * 24h on staging (microsoft-365 v0.12.0, fixed in v0.14.2, #758). Chaining off
 * env via the prototype preserves whatever shape the caller had, plain or
 * wrapped.
 */
export function overlaySprigr<E extends object>(env: E, sprigr: unknown): E {
  const out = Object.create(env) as E;
  Object.defineProperty(out, 'SPRIGR', { value: sprigr, enumerable: false, configurable: false });
  return out;
}

/** Reply shape of `/internal/wfp/emit`. */
export interface WfpEmitReply {
  ok?: boolean;
  eventId?: string;
  /** False when the platform accepted the call but the enqueue itself failed. */
  queued?: boolean;
  error?: string;
}

/** How the emit reached the platform. `none` means it never left. */
export type EmitTransport = 'binding' | 'http' | 'none';

export interface EmitResult {
  emitted: boolean;
  eventId?: string;
  /** Which transport carried it. Worth recording in an audit row: it makes the
   *  binding silently disappearing again visible without a redeploy. */
  via: EmitTransport;
  error?: string;
}

/** Default ceiling on the platform call. A webhook ack matters more than the
 *  event: providers retry a failed delivery, and a slow emit must never turn
 *  the ack into a non-2xx. */
export const DEFAULT_EMIT_TIMEOUT_MS = 5_000;

export interface EmitMarketplaceEventOptions extends MarketplaceEventEmitOpts {
  /** Override the 5s ceiling on the HTTP fallback. */
  timeoutMs?: number;
}

/** Drop `undefined` values so the platform never sees an explicit `undefined`
 *  in the JSON body. It validates `sourceIntegration` strictly (both
 *  `integrationId` and `integrationType` required) and 400s on a partial one. */
function compactOpts(opts: MarketplaceEventEmitOpts | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!opts) return out;
  if (opts.sourceIntegration !== undefined) out.sourceIntegration = opts.sourceIntegration;
  if (opts.targetAppInstallationId !== undefined) out.targetAppInstallationId = opts.targetAppInstallationId;
  if (opts.dedupId !== undefined) out.dedupId = opts.dedupId;
  return out;
}

/** Narrow an unknown `env.SPRIGR` down to a callable `emit`. */
function bindingEmit(
  env: WfpBridgeEnv,
): ((event: string, payload: unknown, opts?: MarketplaceEventEmitOpts) => Promise<WfpEmitReply>) | null {
  const sprigr = env.SPRIGR as { emit?: unknown } | undefined;
  return typeof sprigr?.emit === 'function'
    ? (sprigr.emit as (event: string, payload: unknown, opts?: MarketplaceEventEmitOpts) => Promise<WfpEmitReply>).bind(
        sprigr,
      )
    : null;
}

/**
 * POST a JSON body to an `/internal/wfp/*` endpoint with the install-token
 * bearer. Returns the parsed reply and throws on a non-2xx, matching what the
 * injected host object does, so callers can treat both paths identically.
 *
 * Shared by every install-token fallback (emit, inbox, collections, files) so
 * the auth header and error-detail extraction live in exactly one place.
 */
export async function installTokenPost(
  bridge: InstallBridge,
  path: string,
  body: unknown,
  opts?: { label?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const label = opts?.label ?? `POST ${path}`;
  const controller = new AbortController();
  const timer =
    opts?.timeoutMs != null ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const resp = await fetch(`${bridge.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!resp.ok) {
      const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      const code = obj && 'error' in obj ? String(obj.error) : text.slice(0, 200);
      // The message keeps its historical shape (callers match on it); the
      // structured fields ride alongside so a caller that wants the status
      // or the platform's error code does not have to parse the message.
      const err = new Error(`${label} failed: ${resp.status} ${code}`) as Error & {
        status: number;
        error: string;
        detail?: string;
      };
      err.status = resp.status;
      err.error = code;
      if (obj && typeof obj.detail === 'string') err.detail = obj.detail;
      throw err;
    }
    return (parsed ?? {}) as Record<string, unknown>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Emit a marketplace event from any execution context, never throwing.
 *
 * Prefers the injected `env.SPRIGR.emit`; falls back to the install-token
 * bridge when it is absent (i.e. on an inline Next route). Safe to call from a
 * webhook receiver: every failure is reported in the result rather than raised,
 * so the provider ack is never at risk.
 *
 *   const r = await emitMarketplaceEvent(env, 'procore.rfi.updated', payload, {
 *     sourceIntegration: { integrationId: env.INSTALL_ID, integrationType: 'procore' },
 *   });
 *   await audit(env, 'emit', JSON.stringify(r));   // records `via`
 */
export async function emitMarketplaceEvent(
  env: WfpBridgeEnv,
  event: string,
  payload: unknown,
  opts?: EmitMarketplaceEventOptions,
): Promise<EmitResult> {
  const { timeoutMs, ...emitOpts } = opts ?? {};
  const compact = compactOpts(emitOpts);
  const passThrough = Object.keys(compact).length > 0 ? (compact as MarketplaceEventEmitOpts) : undefined;

  const injected = bindingEmit(env);
  if (injected) {
    try {
      const r = await injected(event, payload, passThrough);
      // A 200 with `queued:false` means the platform took the call but the
      // enqueue failed. Treating that as success is how an event disappears
      // without a trace (shopify silent-drop, 2026-05-28).
      if (r && r.queued === false) {
        return { emitted: false, via: 'binding', eventId: r.eventId, error: r.error ?? 'not_queued' };
      }
      return { emitted: r?.ok !== false, via: 'binding', eventId: r?.eventId };
    } catch (err) {
      return { emitted: false, via: 'binding', error: err instanceof Error ? err.message : String(err) };
    }
  }

  const bridge = resolveInstallBridge(env);
  if (!bridge) return { emitted: false, via: 'none', error: describeMissingBridge(env) };

  try {
    const reply = (await installTokenPost(
      bridge,
      '/internal/wfp/emit',
      { event, payload: payload === undefined ? null : payload, ...compact },
      { label: 'emit', timeoutMs: timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS },
    )) as WfpEmitReply;
    if (reply.ok === false || reply.queued === false) {
      return { emitted: false, via: 'http', eventId: reply.eventId, error: reply.error ?? 'not_queued' };
    }
    return { emitted: true, via: 'http', eventId: reply.eventId };
  } catch (err) {
    return { emitted: false, via: 'http', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether an emit could reach the platform at all, by either transport.
 *
 * Use it to skip work whose only purpose is to feed an emit. Gate on this
 * rather than on `env.SPRIGR?.emit`: the binding is absent on every inline
 * route, so the narrower check skips the work in exactly the context where the
 * HTTP bridge would have carried it.
 */
export function canEmit(env: WfpBridgeEnv): boolean {
  return bindingEmit(env) !== null || resolveInstallBridge(env) !== null;
}

/**
 * Pre-bind an app's `integrationType` so call sites pass only what varies.
 * `sourceIntegration` is built per call from `env.INSTALL_ID`, and omitted
 * entirely when that is unbound (the platform 400s on a partial one).
 *
 *   const emit = createMarketplaceEmitter('procore');
 *   const r = await emit(env, 'procore.rfi.updated', payload);
 */
export function createMarketplaceEmitter<E extends WfpBridgeEnv = WfpBridgeEnv>(
  integrationType: string,
  defaults: { timeoutMs?: number } = {},
): (env: E, eventName: string, payload: unknown) => Promise<EmitResult> {
  return (env, eventName, payload) => {
    const installId = typeof env.INSTALL_ID === 'string' ? env.INSTALL_ID : '';
    return emitMarketplaceEvent(env, eventName, payload, {
      ...defaults,
      ...(installId ? { sourceIntegration: { integrationId: installId, integrationType } } : {}),
    });
  };
}

/**
 * Return an env whose `SPRIGR.emit` works even on an inline route, leaving
 * existing `env.SPRIGR.emit(...)` call sites untouched. Use this when an app
 * emits from many places; use `emitMarketplaceEvent` for a single call site.
 *
 * The installed `emit` matches the injected host object's contract: it resolves
 * `{ ok, eventId, queued }` and THROWS on a non-2xx, so existing
 * `queued === false` checks and try/catch blocks keep working unchanged.
 *
 * When the bindings are absent the env is returned as-is (`SPRIGR` stays
 * undefined) so callers fail the same way they already do rather than
 * discovering a new shape.
 */
export function withSprigrEmitFallback<E extends WfpBridgeEnv & object>(env: E): E {
  if (bindingEmit(env)) return env;
  const bridge = resolveInstallBridge(env);
  if (!bridge) return env;

  const emit = async (
    event: string,
    payload: unknown,
    opts?: MarketplaceEventEmitOpts,
  ): Promise<WfpEmitReply> =>
    (await installTokenPost(
      bridge,
      '/internal/wfp/emit',
      { event, payload: payload === undefined ? null : payload, ...compactOpts(opts) },
      { label: 'emit', timeoutMs: DEFAULT_EMIT_TIMEOUT_MS },
    )) as WfpEmitReply;

  // Preserve any other namespaces already on SPRIGR (data, files, inbox): we
  // are repairing emit, not replacing the host object.
  const existing = (env.SPRIGR ?? {}) as Record<string, unknown>;
  return overlaySprigr(env, { ...existing, emit });
}

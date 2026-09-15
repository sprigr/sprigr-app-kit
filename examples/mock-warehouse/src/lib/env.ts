/**
 * mock-warehouse - per-install env contract and the host-call guard.
 *
 * The only platform surface this app uses is `env.SPRIGR.emit` (the provider
 * events) and `env.SPRIGR.log` (telemetry that must not become D1 rows).
 * Both are staging-only: under `sprigr app dev` the harness's SPRIGR stub
 * throws, and in a plain unit test there is no SPRIGR at all.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface MockWarehouseHost {
  emit(event: string, payload: Record<string, unknown>): Promise<unknown>;
  log?(entry: { level: string; message: string; context?: Record<string, unknown> }): Promise<unknown>;
}

export interface MockWarehouseEnv {
  /** Per-install D1. Always bound on the platform; absent in a unit test. */
  DB?: D1Like;
  /** Platform host object. Absent under a unit test, stubbed under `sprigr app dev`. */
  SPRIGR?: MockWarehouseHost;
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  [key: string]: unknown;
}

declare global {
  interface CloudflareEnv extends MockWarehouseEnv {}
}

export {};

export interface EmitOutcome {
  event: string;
  emitted: boolean;
  reason?: string;
}

/**
 * Emit a provider event, reporting rather than throwing when the host is not
 * there. An adapter op must acknowledge inside the dispatch budget whatever
 * the platform is doing, so a failed emit is a recorded outcome, never an
 * exception that turns an ack into a 500.
 */
export async function safeEmit(
  env: MockWarehouseEnv,
  event: string,
  payload: Record<string, unknown>,
): Promise<EmitOutcome> {
  if (!env.SPRIGR) return { event, emitted: false, reason: 'no SPRIGR host bound (local unit test)' };
  try {
    await env.SPRIGR.emit(event, payload);
    return { event, emitted: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { event, emitted: false, reason };
  }
}

/** Fire-and-forget telemetry. Never a D1 row: this fires per advance call. */
export async function report(
  env: MockWarehouseEnv,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await env.SPRIGR?.log?.({ level: 'info', message, context });
  } catch {
    console.warn(`[mock-warehouse] ${message}`, context);
  }
}

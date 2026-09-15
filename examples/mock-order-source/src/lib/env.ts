/**
 * mock-order-source - per-install env contract and the host-call guard.
 *
 * Same shape as the mock-warehouse side: the only platform surface is
 * `env.SPRIGR.emit` (the order_source events) and `env.SPRIGR.log`. Both are
 * staging-only, so a failed emit is a recorded outcome rather than an
 * exception that turns an ack into a 500.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface MockOrderSourceHost {
  emit(event: string, payload: Record<string, unknown>): Promise<unknown>;
  log?(entry: { level: string; message: string; context?: Record<string, unknown> }): Promise<unknown>;
}

export interface MockOrderSourceEnv {
  DB?: D1Like;
  SPRIGR?: MockOrderSourceHost;
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  [key: string]: unknown;
}

declare global {
  interface CloudflareEnv extends MockOrderSourceEnv {}
}

export {};

export interface EmitOutcome {
  event: string;
  emitted: boolean;
  reason?: string;
}

export async function safeEmit(
  env: MockOrderSourceEnv,
  event: string,
  payload: Record<string, unknown>,
): Promise<EmitOutcome> {
  if (!env.SPRIGR) return { event, emitted: false, reason: 'no SPRIGR host bound (local unit test)' };
  try {
    await env.SPRIGR.emit(event, payload);
    return { event, emitted: true };
  } catch (err) {
    return { event, emitted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function report(
  env: MockOrderSourceEnv,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await env.SPRIGR?.log?.({ level: 'info', message, context });
  } catch {
    console.warn(`[mock-order-source] ${message}`, context);
  }
}

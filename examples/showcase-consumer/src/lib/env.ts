/**
 * Showcase Consumer - per-install env contract.
 *
 * The only env.SPRIGR surface this app uses is `invoke` (cross-tenant tool
 * dispatch to the showcase app). It's staging-only under `sprigr app dev`.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

/** Narrow host type: this consumer only needs env.SPRIGR.invoke. */
export interface ConsumerSprigrHost {
  invoke(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ConsumerEnv {
  DB: D1Like;
  SPRIGR: ConsumerSprigrHost;
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  [key: string]: unknown;
}

declare global {
  interface CloudflareEnv extends ConsumerEnv {}
}

export {};

export type HandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; reason: string }
  | { ok: false; staging_only: true; hint: string };

/** Catch the `sprigr app dev` SPRIGR-stub throw and return a clean marker. */
export async function stagingOnly(
  fn: () => Promise<unknown>,
  hint: string,
): Promise<{ ok: true; result: unknown } | { ok: false; staging_only: true; hint: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('is not available in') && msg.includes('sprigr app dev')) {
      return { ok: false, staging_only: true, hint };
    }
    throw err;
  }
}

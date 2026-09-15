/**
 * Showcase Consumer - per-install env contract.
 *
 * The only env.SPRIGR surface this app uses is `invoke` (cross-tenant tool
 * dispatch to the showcase app). It's staging-only under `sprigr app dev`.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

/** One live provider of an interface, as env.SPRIGR.grants.providers returns it. */
export interface InterfaceProvider {
  app_slug: string;
  install_id: string;
  interface_version: string;
  /** op -> the provider's tool name, what env.SPRIGR.invoke takes. */
  ops: Record<string, string>;
  status: 'active' | 'pending_review' | 'provider_inactive' | 'revoked';
}

/**
 * Narrow host type: this consumer needs env.SPRIGR.invoke and, since it
 * requires an INTERFACE rather than a provider slug (decision 0077),
 * env.SPRIGR.grants.providers to learn which tool names are bound.
 */
export interface ConsumerSprigrHost {
  invoke(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
  grants: {
    providers(interfaceId: string, opts?: { version?: string }): Promise<InterfaceProvider[]>;
  };
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

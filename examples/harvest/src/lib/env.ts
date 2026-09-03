/**
 * Harvest - per-install env binding contract.
 *
 * The marketplace runtime binds these onto the per-install WFP script:
 *   - DB          - per-install D1 (always)
 *   - INSTALL_ID / COMPANY_ID / APP_SLUG - runtime-injected identifiers
 *   - SPRIGR_INSTALL_TOKEN / SPRIGR_PLATFORM_BASE - platform API access
 *   - HARVEST_CLIENT_ID / HARVEST_CLIENT_SECRET - publisher-
 *     provided manifest secrets, shared across installs (seeded via
 *     `sprigr app set-publisher-secrets`)
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface HarvestEnv {
  DB: D1Like;
  HARVEST_CLIENT_ID: string;
  HARVEST_CLIENT_SECRET: string;
  /** Optional - only present when the runtime injects it. */
  /** `auto_generate` manifest secret: the AES-GCM key that wraps this
   *  install's tokens at rest. The platform mints it per install. */
  HARVEST_TOKEN_KEK: string;
  INSTALL_ID?: string;
  /** Optional - only present when the runtime injects it. */
  COMPANY_ID?: string;
  /** Optional - only present when the runtime injects it. */
  APP_SLUG?: string;
  /** Anything else CloudflareEnv has - keeps the type assignable to
   *  the OpenNext-cloudflare CloudflareEnv constraint. */
  [key: string]: unknown;
}

/**
 * Augment the global CloudflareEnv interface (declared by
 * @opennextjs/cloudflare) so `getCloudflareContext()` returns an env
 * with our manifest-declared bindings typed.
 */
declare global {
  interface CloudflareEnv extends HarvestEnv {}
}

export {};

export function requireClientId(env: HarvestEnv): string {
  if (!env.HARVEST_CLIENT_ID) {
    throw new Error('HARVEST_CLIENT_ID not set. Seed publisher secrets before use.');
  }
  return env.HARVEST_CLIENT_ID;
}

export function requireClientSecret(env: HarvestEnv): string {
  if (!env.HARVEST_CLIENT_SECRET) {
    throw new Error('HARVEST_CLIENT_SECRET not set. Seed publisher secrets before use.');
  }
  return env.HARVEST_CLIENT_SECRET;
}

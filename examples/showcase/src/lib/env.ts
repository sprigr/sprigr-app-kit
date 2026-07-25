/**
 * Showcase - per-install env binding contract + the env.SPRIGR host type.
 *
 * The marketplace runtime binds these onto the per-install WFP script and
 * `sprigr app dev` mirrors the shape locally:
 *   - DB          - per-install D1 (always; local SQLite under `app dev`)
 *   - INSTALL_ID / COMPANY_ID / APP_SLUG - runtime-injected identifiers
 *   - SPRIGR      - the platform host object (env.SPRIGR.*). ALL of its
 *                   methods are staging-only: the `sprigr app dev` harness
 *                   installs a Proxy stub that THROWS on any access with a
 *                   "publish to staging" pointer. Handlers wrap those calls
 *                   in `stagingOnly()` (see below) so local dev drives cleanly.
 *   - ACME_*      - manifest secrets[] (brand-supplied + publisher_provides)
 *   - SHOWCASE_STATE_HMAC_KEY - auto_generate per-install secret
 */

import type { D1Like } from '@sprigr/apps-app-sdk';
import type { SprigrHost } from './sprigr-host';

export interface ShowcaseEnv {
  DB: D1Like;
  /** env.SPRIGR platform host — every method is staging-only (see stagingOnly). */
  SPRIGR: SprigrHost;
  /** Brand-supplied HMAC secret for per-install webhook verification. */
  ACME_WEBHOOK_SECRET: string;
  /** Publisher-provided shared secret for the app-level shared webhook. */
  ACME_SHARED_WEBHOOK_SECRET: string;
  /** Publisher-provided OAuth client id/secret (shared across installs). */
  ACME_CLIENT_ID: string;
  ACME_CLIENT_SECRET: string;
  /** Auto-generated per-install key for signing the OAuth state blob. */
  SHOWCASE_STATE_HMAC_KEY?: string;
  /** Runtime-injected identifiers (present on the platform + under app dev). */
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  /** Keep assignable to the OpenNext CloudflareEnv constraint. */
  [key: string]: unknown;
}

/**
 * Augment the global CloudflareEnv interface (declared by
 * @opennextjs/cloudflare) so `getCloudflareContext()` returns a typed env.
 */
declare global {
  interface CloudflareEnv extends ShowcaseEnv {}
}

export {};

/** Uniform envelope every handler returns. */
export type HandlerOk = { ok: true; result: unknown };
export type HandlerErr = { ok: false; reason: string };
/**
 * Returned when a code path needs a real `env.SPRIGR.*` call that the local
 * `sprigr app dev` harness cannot serve. The harness stub throws with a
 * staging pointer; `stagingOnly()` catches it and returns this instead of
 * crashing, so local dev exercises the surrounding logic cleanly.
 */
export type HandlerStagingOnly = { ok: false; staging_only: true; hint: string };
export type HandlerResult = HandlerOk | HandlerErr | HandlerStagingOnly;

/**
 * Run a block that touches `env.SPRIGR.*`. On the platform it runs for real.
 * Under `sprigr app dev` the SPRIGR proxy throws
 * `env.SPRIGR.<x> is not available in \`sprigr app dev\` ... Publish to
 * staging ...`; we detect that message and return a { staging_only } marker
 * so the CLI dispatch still returns 200 and the author sees the shape.
 *
 * A genuine platform error (bad grant, no consent) is re-thrown as a normal
 * failure so callers can branch on err.code — only the dev-stub throw is
 * swallowed.
 */
export async function stagingOnly(
  fn: () => Promise<unknown>,
  hint: string,
): Promise<HandlerOk | HandlerStagingOnly> {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('is not available in') && msg.includes('sprigr app dev')) {
      return { ok: false, staging_only: true, hint };
    }
    throw err;
  }
}

export function requireClientId(env: ShowcaseEnv): string {
  if (!env.ACME_CLIENT_ID) {
    throw new Error('ACME_CLIENT_ID not set. Seed publisher secrets before use.');
  }
  return env.ACME_CLIENT_ID;
}

export function requireClientSecret(env: ShowcaseEnv): string {
  if (!env.ACME_CLIENT_SECRET) {
    throw new Error('ACME_CLIENT_SECRET not set. Seed publisher secrets before use.');
  }
  return env.ACME_CLIENT_SECRET;
}

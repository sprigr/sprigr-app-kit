/**
 * Showcase - env.SPRIGR.store.* reference module.
 *
 * The company/publisher key-value store (requires the sprigr.jobs scope;
 * scope:'publisher' additionally requires sprigr.jobs:publisher). Values are
 * STRINGS — JSON.stringify objects yourself, 128KB cap. Every call here is
 * staging-only; the smoke test asserts the call shapes against a fake SPRIGR.
 *
 * This is a reference module (not a manifest tools[] handler) — import the
 * functions from a real handler when you need shared cross-run state, e.g. a
 * reused cursor or a publisher-shared login cookie.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';

/** Company-scoped cursor persistence (per install's company). */
export async function saveCursor(env: ShowcaseEnv, cursor: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.store.put('sync:cursor', cursor, { scope: 'company', ttlSeconds: 86_400 }),
    'saveCursor writes env.SPRIGR.store.put — publish to staging.',
  );
}

export async function loadCursor(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.store.get('sync:cursor', { scope: 'company' }),
    'loadCursor reads env.SPRIGR.store.get — publish to staging.',
  );
}

export async function listCursors(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.store.list({ scope: 'company', prefix: 'sync:' }),
    'listCursors reads env.SPRIGR.store.list — publish to staging.',
  );
}

export async function clearCursor(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.store.delete('sync:cursor', { scope: 'company' }),
    'clearCursor calls env.SPRIGR.store.delete — publish to staging.',
  );
}

/**
 * Publisher-scoped read: shared across every install of this app. Requires
 * the sprigr.jobs:publisher scope; a missing scope throws with
 * err.code='scope_not_granted' on the platform (not swallowed by stagingOnly).
 */
export async function readPublisherSecretRef(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.store.get('shared:acme_session', { scope: 'publisher' }),
    'readPublisherSecretRef reads env.SPRIGR.store.get scope=publisher — publish to staging.',
  );
}

/**
 * Harvest - per-install D1 stores.
 *
 * Thin wrappers around @sprigr/apps-d1-kv, pinned to this
 * app's table names (created by migrations/0001_init.sql).
 */

import { makeSettingsStore, makeD1TokenStore } from '@sprigr/apps-d1-kv';
import type { D1Like } from '@sprigr/apps-app-sdk';
import type { HarvestEnv } from './env';

export const settings = (db: D1Like) => makeSettingsStore({ db, table: 'harvest_settings' });

/**
 * Token store for oauth-utils.
 *
 * Encrypts at rest under the install's own key. `HARVEST_TOKEN_KEK` is an
 * `auto_generate` manifest secret, so the platform mints 32 random bytes per
 * install and neither the publisher nor the brand ever sees it. A missing key
 * throws rather than degrading to cleartext, which is the point: a silent
 * fallback would look exactly like a working store.
 *
 * A NEW app can go straight to `encrypt` because a fresh install receives the
 * secret at install time. An app that ALREADY has installs cannot: the key
 * only reaches those on their next upgrade, so it ships `decrypt-only` first
 * and flips to `encrypt` once every install holds a key. See
 * sprigr-apps#1450.
 */
export const tokens = (env: HarvestEnv) =>
  makeD1TokenStore({
    db: env.DB,
    table: 'harvest_secrets',
    encryption: { mode: 'encrypt', kek: env.HARVEST_TOKEN_KEK },
  });

export async function getSetting(db: D1Like, key: string): Promise<string | null> {
  return settings(db).get(key);
}

export async function setSetting(db: D1Like, key: string, value: string): Promise<void> {
  return settings(db).set(key, value);
}

export async function deleteSetting(db: D1Like, key: string): Promise<void> {
  return settings(db).delete(key);
}

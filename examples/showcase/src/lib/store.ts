/**
 * Showcase - per-install D1 stores.
 *
 * Thin wrappers around @sprigr/apps-d1-kv, pinned to this app's table
 * names (created by migrations/0001_init.sql + 0002_install_config.sql).
 * Everything here runs locally under `sprigr app dev` against the local
 * SQLite D1 — no platform calls.
 */

import { makeSettingsStore, makeD1TokenStore } from '@sprigr/apps-d1-kv';
import type { D1Like } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv } from './env';

export const settings = (db: D1Like) => makeSettingsStore({ db, table: 'showcase_settings' });

/**
 * Token store for oauth-utils.
 *
 * Encrypts at rest under the install's own key. `SHOWCASE_TOKEN_KEK` is an
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
export const tokens = (env: ShowcaseEnv) =>
  makeD1TokenStore({
    db: env.DB,
    table: 'showcase_secrets',
    encryption: { mode: 'encrypt', kek: env.SHOWCASE_TOKEN_KEK },
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

/**
 * Install-config override (migration 0002). Mirrors the private-repo pattern:
 * the handler UPSERTs config the brand set in the portal (which lands in
 * app_installations.config on the platform) into a D1-local row so a handler
 * can read e.g. decision_route_decision_workflow_id without a round-trip.
 */
export async function setInstallConfig(db: D1Like, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO showcase_install_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}

export async function getInstallConfig(db: D1Like, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM showcase_install_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

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

export const settings = (db: D1Like) => makeSettingsStore({ db, table: 'showcase_settings' });
export const tokens = (db: D1Like) => makeD1TokenStore({ db, table: 'showcase_secrets' });

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

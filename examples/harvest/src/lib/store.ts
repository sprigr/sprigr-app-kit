/**
 * Harvest - per-install D1 stores.
 *
 * Thin wrappers around the vendored d1-kv package, pinned to this
 * app's table names (created by migrations/0001_init.sql).
 */

import { makeSettingsStore, makeD1TokenStore } from './vendor/d1-kv';
import type { D1Like } from './vendor/app-sdk';

export const settings = (db: D1Like) => makeSettingsStore({ db, table: 'harvest_settings' });
export const tokens = (db: D1Like) => makeD1TokenStore({ db, table: 'harvest_secrets' });

export async function getSetting(db: D1Like, key: string): Promise<string | null> {
  return settings(db).get(key);
}

export async function setSetting(db: D1Like, key: string, value: string): Promise<void> {
  return settings(db).set(key, value);
}

export async function deleteSetting(db: D1Like, key: string): Promise<void> {
  return settings(db).delete(key);
}

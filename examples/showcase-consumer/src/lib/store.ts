/**
 * Showcase Consumer - install-config override store.
 *
 * The private-repo install-config pattern, genericized: the portal sets
 * app_installations.config on the platform; a handler (consumer_set_config)
 * UPSERTs the values it needs into a D1-local row so runtime reads are local.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export async function setInstallConfig(db: D1Like, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO consumer_install_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}

export async function getInstallConfig(db: D1Like, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM consumer_install_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

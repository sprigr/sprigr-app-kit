/**
 * Per-install D1 registry of provider-side webhook subscriptions.
 *
 * Provider-agnostic. Use it whenever an app's `on_install` (or a
 * `reconcile_webhooks` tool) calls a provider's webhook-create API
 * and needs to remember the subscription ids the provider returns,
 * so subsequent invocations can short-circuit already-registered
 * topics and remove/rotate the rest.
 *
 * Schema this expects (apps own the migration; pick whatever table
 * name suits, the package only requires the column shape):
 *
 *   CREATE TABLE <app>_webhook_subs (
 *     topic            TEXT PRIMARY KEY,
 *     subscription_id  TEXT NOT NULL,
 *     callback_url     TEXT NOT NULL,
 *     registered_at    TEXT NOT NULL DEFAULT (datetime('now'))
 *   );
 *
 * Why a registry: every provider hands you back a subscription id
 * when you create a webhook. You need that id later to delete or
 * update the subscription, and you need a way to ask "is `topic`
 * already subscribed" before calling create again (re-running
 * on_install on an existing install must not double-subscribe).
 *
 * Typical wiring (app supplies the provider-specific create call):
 *
 *   const reg = makeWebhookRegistry({ db: env.DB, table: 'webhook_subs' });
 *   for (const topic of TOPICS) {
 *     if (await reg.find(topic)) continue;  // already subscribed
 *     const callbackUrl = computeCallbackUrl(topic);
 *     const { id } = await provider.createSubscription({ topic, callbackUrl });
 *     await reg.record(topic, id, callbackUrl);
 *   }
 *
 * No provider-API abstraction here on purpose. Every provider's
 * webhook-create call has a different shape (GraphQL mutation,
 * REST POST + trigger rows, HTTP form-encoded, ...). The registry
 * stays small and the app owns the create call.
 */

import type { D1Like } from './types';

export interface WebhookSubRecord {
  topic: string;
  subscriptionId: string;
  callbackUrl: string;
  registeredAt: string;
}

export interface WebhookRegistry {
  list(): Promise<WebhookSubRecord[]>;
  find(topic: string): Promise<WebhookSubRecord | null>;
  record(topic: string, subscriptionId: string, callbackUrl: string): Promise<void>;
  remove(topic: string): Promise<void>;
}

export interface MakeWebhookRegistryOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeWebhookRegistry(opts: MakeWebhookRegistryOpts): WebhookRegistry {
  const { db, table } = opts;
  assertIdent(table);

  return {
    async list() {
      const result = await db
        .prepare(
          `SELECT topic, subscription_id AS subscriptionId,
                  callback_url AS callbackUrl, registered_at AS registeredAt
             FROM ${table}
            ORDER BY topic`,
        )
        .all<WebhookSubRecord>();
      return result.results ?? [];
    },
    async find(topic) {
      const row = await db
        .prepare(
          `SELECT topic, subscription_id AS subscriptionId,
                  callback_url AS callbackUrl, registered_at AS registeredAt
             FROM ${table}
            WHERE topic = ?`,
        )
        .bind(topic)
        .first<WebhookSubRecord>();
      return row ?? null;
    },
    async record(topic, subscriptionId, callbackUrl) {
      await db
        .prepare(
          `INSERT INTO ${table} (topic, subscription_id, callback_url, registered_at)
             VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(topic) DO UPDATE SET
             subscription_id = excluded.subscription_id,
             callback_url = excluded.callback_url,
             registered_at = datetime('now')`,
        )
        .bind(topic, subscriptionId, callbackUrl)
        .run();
    },
    async remove(topic) {
      await db.prepare(`DELETE FROM ${table} WHERE topic = ?`).bind(topic).run();
    },
  };
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `webhook-registry: table name "${name}" is not a plain SQL identifier`,
    );
  }
}

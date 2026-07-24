/**
 * @sprigr/apps-webhook-registry
 *
 * Per-install D1 registry of provider-side webhook subscriptions.
 * One factory:
 *
 *   makeWebhookRegistry({db, table})
 *     → { list, find, record, remove }
 *
 * Apps own the provider-specific create/delete API calls. The
 * registry just tracks (topic → subscription_id) so re-running an
 * on_install hook doesn't double-subscribe.
 *
 * See `webhook-registry.ts` for schema + a typical wiring example.
 */

export { makeWebhookRegistry } from './webhook-registry';
export type {
  WebhookRegistry,
  WebhookSubRecord,
  MakeWebhookRegistryOpts,
} from './webhook-registry';
export type { D1Like, D1PreparedStatementLike } from './types';

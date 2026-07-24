/**
 * Per-env resolver for the platform webhook host that marketplace
 * apps use as the callback URL when registering provider webhooks.
 *
 * Why this exists:
 * Every app that registers webhooks with a third-party provider at
 * OAuth-completion time has to tell the provider "POST inbound events
 * to <some URL>". For the apps that route through the marketplace
 * runtime's dispatcher (e.g. shopify -> /webhook/marketplace/{installId}/{topic}),
 * that URL has to point at the env-correct platform host:
 *
 *   - prod    : https://webhooks.sprigr.com
 *   - staging : https://staging-webhooks.sprigr.com
 *
 * The marketplace build-runner already injects this value as
 * `env.SPRIGR_PLATFORM_BASE` on every per-install WFP upload (platform
 * build-runner). Apps
 * just need to read it.
 *
 * The bug this prevents:
 * Hardcoding `'https://webhooks.sprigr.com'` as the default makes a
 * staging install register prod-pointing webhook subscriptions with
 * the provider. The provider duly fires events at prod; prod's
 * platform doesn't know the staging install id, so the webhooks
 * silently fail (404s land in the *prod* tail, invisible to the
 * staging operator). The staging chain stays dead until someone
 * notices the empty inbound queue and traces it back.
 *
 * When NOT to use this:
 * Apps that receive webhooks on their OWN per-install URL (e.g.
 * procore POSTs to `<procore-XXX.staging-apps.sprigr.com>/api/webhook/procore`)
 * don't go through the marketplace runtime dispatcher. Those apps
 * derive the callback URL from the inbound request's `Host` header
 * instead, which is naturally env-correct. This helper is only for
 * the marketplace-dispatcher pattern.
 */

/**
 * Minimal env shape this helper reads. Apps' ShopifyEnv /
 * ProcoreEnv / etc. all extend this; passing the full env is fine.
 */
export interface PlatformHostEnv {
  SPRIGR_PLATFORM_BASE?: string;
}

/**
 * Production fallback when no env var is set. Picked deliberately:
 * an app with no platform binding (e.g. a unit test, a local dev
 * run before the runtime wires bindings) is safer pointing at prod
 * (where mistakes are visible in a healthy environment) than
 * pointing at nothing.
 */
const FALLBACK_PLATFORM_BASE = 'https://webhooks.sprigr.com';

/**
 * Returns the marketplace platform's webhook ingest host for the
 * current env. Trailing slash is always stripped so callers can
 * concatenate path segments directly.
 *
 *   const base = resolvePlatformWebhookBase(env);
 *   // staging: "https://staging-webhooks.sprigr.com"
 *   // prod:    "https://webhooks.sprigr.com"
 *   const callbackUrl = `${base}/webhook/marketplace/${installId}/${topicPath}`;
 *
 * Caller-supplied `override` wins over the env var, useful for
 * one-off migration scripts and tests.
 */
export function resolvePlatformWebhookBase(
  env: PlatformHostEnv,
  override?: string | null,
): string {
  const raw = (override ?? env.SPRIGR_PLATFORM_BASE ?? FALLBACK_PLATFORM_BASE).trim();
  return raw.replace(/\/$/, '');
}

/**
 * Convenience wrapper for the most common shape: build the full
 * marketplace-dispatcher webhook URL for a given install + topic
 * path.
 *
 *   buildMarketplaceWebhookUrl(env, 'inst_abc', 'orders-create')
 *   // -> "https://staging-webhooks.sprigr.com/webhook/marketplace/inst_abc/orders-create"
 *
 * The `topicPath` argument is the manifest path segment (e.g.
 * `orders-create`, not `orders/create`). Apps that need the slash
 * form should pre-translate before calling.
 */
export function buildMarketplaceWebhookUrl(
  env: PlatformHostEnv,
  installId: string,
  topicPath: string,
  override?: string | null,
): string {
  const base = resolvePlatformWebhookBase(env, override);
  return `${base}/webhook/marketplace/${installId}/${topicPath}`;
}

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

/* ------------------------------------------------------------------ *
 * OAuth bouncer host resolution
 * ------------------------------------------------------------------ */

const OAUTH_BOUNCER_PROD = 'https://oauth-bouncer.sprigr.com';
const OAUTH_BOUNCER_STAGING = 'https://staging-oauth-bouncer.sprigr.com';

/**
 * Is this URL (or bare hostname) served by a STAGING host?
 *
 * Every Sprigr staging host is `staging-<something>.sprigr.com`:
 * `staging-apps` (per-install app sites), `staging-sites` (the
 * preview-token host from `get_website_preview`), `staging-team` (the
 * portal), `staging-webhooks` (the platform base). No prod host carries
 * a `staging-` label.
 *
 * Tests the HOSTNAME, not a substring of the whole URL. Eight apps
 * previously hand-rolled
 *
 *     reqUrl.includes('staging-apps.sprigr.com') ||
 *     reqUrl.includes('staging-team.sprigr.com')
 *
 * which was wrong in BOTH directions. It missed `staging-sites`, so a
 * staging install served from the preview host built an authorize URL
 * pointing at the PRODUCTION bouncer — which cannot resolve a staging
 * install id, so the connect died at the bouncer with a confusing error
 * (observed live 2026-07-25 by reading the Location header off a
 * deployed /oauth/start). And because it matched the whole URL, a PROD
 * install hit with `?return_to=https://staging-team.sprigr.com/x` was
 * classified as staging. Parsing the hostname closes both.
 *
 * Unparseable input resolves to `false` (prod), so a caller can never
 * accidentally point production traffic at staging.
 */
export function isStagingHost(urlOrHostname: string | null | undefined): boolean {
  const raw = (urlOrHostname ?? '').trim();
  if (!raw) return false;
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    // Not a full URL. Accept a bare hostname (`staging-team.sprigr.com`),
    // but never a fragment that merely contains host-ish characters.
    hostname = /^[a-z0-9.-]+$/i.test(raw) ? raw : '';
  }
  return /(^|\.)staging-/.test(hostname);
}

/**
 * Signals an app can offer to decide which bouncer to use. Pass whatever
 * the call site actually has:
 *
 *   - `reqUrl`       an inbound browser request URL (the /oauth/start route).
 *   - `platformBase` the platform-stamped `SPRIGR_PLATFORM_BASE`, for tool
 *                    handlers dispatched on /__sprigr/tool/* where there is
 *                    no browser origin. Staging value is
 *                    `https://staging-webhooks.sprigr.com`.
 *   - `override`     an explicit per-install redirect URI / bouncer base.
 *                    Always wins; used for local dev and canaries.
 *
 * Staging wins if ANY supplied signal says staging.
 */
export interface OAuthBouncerSignals {
  reqUrl?: string | null;
  platformBase?: string | null;
  override?: string | null;
}

/**
 * The bouncer ORIGIN for the environment serving this request, e.g.
 * `https://staging-oauth-bouncer.sprigr.com`. Never has a trailing slash.
 *
 * `override` short-circuits everything (trailing slash stripped).
 */
export function resolveOAuthBouncerBase(signals: OAuthBouncerSignals = {}): string {
  const override = (signals.override ?? '').trim();
  if (override) return override.replace(/\/$/, '');
  const isStaging =
    isStagingHost(signals.reqUrl) || isStagingHost(signals.platformBase);
  return isStaging ? OAUTH_BOUNCER_STAGING : OAUTH_BOUNCER_PROD;
}

/**
 * The full bouncer CALLBACK URL for a provider, which is the value that
 * goes in an authorize URL's `redirect_uri` and must be registered as a
 * redirect URI on the provider's developer app:
 *
 *   resolveOAuthBouncerCallbackUrl('simpro', { reqUrl: req.url })
 *   // -> "https://staging-oauth-bouncer.sprigr.com/simpro/oauth/callback"
 *
 * `override` is returned verbatim (no provider path appended) — an app
 * pointing at a local bouncer supplies the complete callback URL.
 */
export function resolveOAuthBouncerCallbackUrl(
  provider: string,
  signals: OAuthBouncerSignals = {},
): string {
  const override = (signals.override ?? '').trim();
  if (override) return override;
  return `${resolveOAuthBouncerBase(signals)}/${provider}/oauth/callback`;
}

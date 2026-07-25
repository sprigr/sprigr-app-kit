/**
 * Showcase - cross-tenant + cross-app reference module.
 *
 *   invoke(toolName, args)         call another app's cross-tenant tool. The
 *                                  platform gates on an active
 *                                  cross_tenant_grants row for
 *                                  (receiver install, tool); a missing grant
 *                                  throws err.code='no_grant_for_tool'. This
 *                                  is the CONSUMER side — see
 *                                  examples/showcase-consumer for a full app.
 *   integrations.invoke(req)       call a tool on a brand-connected built-in
 *                                  integration (declared in
 *                                  integration_dependencies). A missing
 *                                  integration throws err.code='no_integration'.
 *   emit(name, payload, opts)      emit a marketplace event; cross-tenant
 *                                  delivery is gated by cross_tenant_emits[]
 *                                  AND the granting brand's consent.
 *   registerChannel(type, id)      map a provider external account id to this
 *                                  channel install (shared-channel routing).
 *
 * All staging-only.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';

/** Optional smoke ping to the hello-marketplace app_dependency (required:false). */
export async function pingHelloMarketplace(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.invoke('hello_ping_tool', { from: 'showcase' }),
    'pingHelloMarketplace calls env.SPRIGR.invoke on an app_dependency grant — publish to staging.',
  );
}

/** Correlate an Acme deal with a Shopify order via integration_dependencies. */
export async function correlateShopifyOrder(
  env: ShowcaseEnv,
  integrationId: string,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.integrations.invoke({
        type: 'shopify',
        integrationId,
        tool: 'shopify_list_orders',
        args: { limit: 5 },
      }),
    'correlateShopifyOrder calls env.SPRIGR.integrations.invoke (integration_dependencies grant) — publish to staging.',
  );
}

/** Emit a cross-tenant event (gated by cross_tenant_emits[] + consent). */
export async function emitDealWonCrossTenant(
  env: ShowcaseEnv,
  deal: { deal_id: string; contact_id?: string; amount?: number },
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.emit('showcase.deal.won', deal),
    'emitDealWonCrossTenant calls env.SPRIGR.emit (cross_tenant_emits gated) — publish to staging.',
  );
}

/** Register this install's Acme Chat team id for shared-channel routing. */
export async function registerChatWorkspace(env: ShowcaseEnv, teamId: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.registerChannel('acme_chat', teamId),
    'registerChatWorkspace calls env.SPRIGR.registerChannel — publish to staging.',
  );
}

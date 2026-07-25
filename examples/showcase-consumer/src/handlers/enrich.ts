/**
 * Showcase Consumer - the CONSUMER side of cross-app wiring.
 *
 *   consumer_enrich_deal  reads the high-value threshold from install config
 *                         (D1-local), then calls the SHOWCASE app's
 *                         cross-tenant tool `showcase_lookup_contact` via
 *                         env.SPRIGR.invoke to enrich the deal. The grant is
 *                         minted from this app's app_dependencies[] on the
 *                         showcase app (receiver_kind='app_installation').
 *   consumer_on_deal_won  event-subscription handler: the platform delivers
 *                         the showcase app's cross-tenant showcase.deal.won
 *                         event here (EventArgs { event, payload, eventId }).
 *   consumer_set_config   mirrors app_installations.config into D1 (UPSERT).
 *
 * env.SPRIGR.invoke is staging-only; the threshold read + config write run
 * locally under `sprigr app dev`.
 */

import { setInstallConfig, getInstallConfig } from '../lib/store';
import { stagingOnly } from '../lib/env';
import type { EventArgs } from '@sprigr/apps-app-sdk';
import type { ConsumerEnv, HandlerResult } from '../lib/env';

interface DealSignal {
  deal_id?: string;
  contact_id: string;
  amount?: number;
}

async function threshold(env: ConsumerEnv): Promise<number> {
  const raw = await getInstallConfig(env.DB, 'high_value_threshold');
  return raw ? Number(raw) : 10000;
}

export async function enrichDeal(env: ConsumerEnv, deal: DealSignal): Promise<HandlerResult> {
  if (!deal.contact_id) return { ok: false, reason: 'contact_id required' };
  const highValue = (deal.amount ?? 0) >= (await threshold(env));

  // Cross-tenant call into the showcase app (staging-only). The platform
  // gates on an active app-to-app grant for showcase_lookup_contact; a
  // missing grant throws err.code='no_grant_for_tool'.
  const lookup = await stagingOnly(
    () => env.SPRIGR.invoke('showcase_lookup_contact', { contact_id: deal.contact_id }),
    'enrichDeal calls env.SPRIGR.invoke(showcase_lookup_contact) — publish to staging and approve the app_dependencies grant.',
  );

  if (!lookup.ok) return lookup; // staging_only marker passes through cleanly
  return { ok: true, result: { deal_id: deal.deal_id, high_value: highValue, contact: lookup.result } };
}

export async function onDealWon(env: ConsumerEnv, args: EventArgs): Promise<HandlerResult> {
  const payload = args.payload as DealSignal;
  return enrichDeal(env, payload);
}

interface SetConfigArgs {
  high_value_threshold?: number;
}
export async function setConfig(env: ConsumerEnv, args: SetConfigArgs): Promise<HandlerResult> {
  if (typeof args.high_value_threshold === 'number') {
    await setInstallConfig(env.DB, 'high_value_threshold', String(args.high_value_threshold));
  }
  return { ok: true, result: { high_value_threshold: await threshold(env) } };
}

export default {
  consumer_enrich_deal: (args: DealSignal, env: ConsumerEnv) => enrichDeal(env, args),
  consumer_on_deal_won: (args: EventArgs, env: ConsumerEnv) => onDealWon(env, args),
  consumer_set_config: (args: SetConfigArgs, env: ConsumerEnv) => setConfig(env, args),
};

/**
 * Showcase Consumer - the CONSUMER side of cross-app wiring.
 *
 *   consumer_enrich_deal  reads the high-value threshold from install config
 *                         (D1-local), then resolves the contact through EVERY
 *                         installed provider of the showcase/contact_lookup
 *                         INTERFACE: env.SPRIGR.grants.providers lists the
 *                         bound tool names (decision 0077), env.SPRIGR.invoke
 *                         calls them. Bindings are minted from this app's
 *                         app_dependencies[] `{ provides }` entry at install
 *                         and back-filled when a provider arrives later.
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

  // Decision 0077: this app requires the INTERFACE showcase/contact_lookup,
  // not the showcase app by slug. Ask the platform which installed apps
  // provide it (bound at install, including providers installed after this
  // app), then call each bound tool name through invoke. The consumer owns
  // the fan-out: first provider that finds the contact wins. Staging-only
  // under `sprigr app dev`.
  const lookup = await stagingOnly(
    async () => {
      const providers = (await env.SPRIGR.grants.providers('showcase/contact_lookup')).filter((p) => p.status === 'active');
      if (providers.length === 0) return { found: false, providers_tried: 0 };
      const attempts = await Promise.allSettled(
        providers.map((p) => env.SPRIGR.invoke(p.ops.lookup_contact!, { contact_id: deal.contact_id })),
      );
      let contact: unknown = null;
      let provider: string | null = null;
      attempts.forEach((a, i) => {
        if (contact === null && a.status === 'fulfilled' && (a.value as { found?: boolean })?.found) {
          contact = (a.value as { contact?: unknown }).contact ?? null;
          provider = providers[i]!.app_slug;
        }
      });
      return { found: contact !== null, contact, provider, providers_tried: providers.length };
    },
    'enrichDeal calls env.SPRIGR.grants.providers(showcase/contact_lookup) + invoke — publish to staging with a provider installed.',
  );

  if (!lookup.ok) return lookup; // staging_only marker passes through cleanly
  return { ok: true, result: { deal_id: deal.deal_id, high_value: highValue, ...(lookup.result as Record<string, unknown>) } };
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

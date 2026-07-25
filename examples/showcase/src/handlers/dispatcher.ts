/**
 * Showcase - the agent-facing dispatcher tool (`showcase`).
 *
 * One tool, many actions selected by `action` (mirrors the manifest
 * dispatch[] catalogue). Demonstrates the split the whole kit turns on:
 *
 *   LOCAL under `sprigr app dev` (runs for real):
 *     - connection_status   reads per-install D1 (env.DB)
 *     - get_contact         pure arg validation + D1 read
 *
 *   STAGING-ONLY (needs env.SPRIGR.*; the dev stub throws, we catch it and
 *   return { ok:false, staging_only:true, hint } so local dispatch is clean):
 *     - list_contacts          -> would call the provider over the network
 *     - search_cached_contacts -> env.SPRIGR.data.search
 *     - cache_contact          -> env.SPRIGR.data.import + env.SPRIGR.emit
 */

import { getSetting } from '../lib/store';
import { ACCOUNT_ID_SETTING, ACCOUNT_NAME_SETTING, AcmeApiError, requireConnected } from '../lib/acme';
import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

export interface DispatcherArgs {
  action:
    | 'list_contacts'
    | 'get_contact'
    | 'search_cached_contacts'
    | 'cache_contact'
    | 'connection_status';
  contact_id?: string;
  stage?: string;
  owner?: string;
  source?: string;
  name?: string;
  email?: string;
  company?: string;
  query?: string;
  hits_per_page?: number;
  page?: number;
  per_page?: number;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new AcmeApiError(`Missing or invalid required argument: ${name} (string)`);
  }
  return v;
}

export async function runDispatcher(env: ShowcaseEnv, args: DispatcherArgs): Promise<HandlerResult> {
  try {
    switch (args.action) {
      case 'connection_status': {
        // LOCAL: pure per-install D1 read.
        const accountId = await getSetting(env.DB, ACCOUNT_ID_SETTING);
        const accountName = await getSetting(env.DB, ACCOUNT_NAME_SETTING);
        return {
          ok: true,
          result: accountId
            ? { connected: true, account_id: accountId, account_name: accountName }
            : { connected: false, hint: 'Open the app settings page and click "Connect Acme".' },
        };
      }

      case 'get_contact': {
        // LOCAL: validation + D1 read (connection guard reads env.DB).
        const contactId = requireString(args.contact_id, 'contact_id');
        await requireConnected(env);
        return { ok: true, result: { contact_id: contactId, hint: 'On the platform this reads api.acme.example.' } };
      }

      case 'search_cached_contacts': {
        // STAGING-ONLY: queries the per-company data index.
        return stagingOnly(
          () =>
            env.SPRIGR.data.search({
              query: args.query ?? '',
              hitsPerPage: args.hits_per_page ?? 20,
              facets: ['stage', 'owner', 'source'],
              ...(args.stage ? { filters: `stage:${args.stage}` } : {}),
            }),
          'search_cached_contacts calls env.SPRIGR.data.search — publish to staging to exercise the data index.',
        );
      }

      case 'cache_contact': {
        // STAGING-ONLY: writes to the data index + emits an event.
        const contactId = requireString(args.contact_id, 'contact_id');
        return stagingOnly(async () => {
          const imported = await env.SPRIGR.data.import([
            {
              objectID: contactId,
              name: args.name ?? '',
              email: args.email ?? '',
              company: args.company ?? '',
              stage: args.stage ?? 'new',
              owner: args.owner ?? '',
              source: args.source ?? 'manual',
            },
          ]);
          await env.SPRIGR.emit('showcase.contact.cached', { contact_id: contactId });
          return imported;
        }, 'cache_contact calls env.SPRIGR.data.import + env.SPRIGR.emit — publish to staging.');
      }

      case 'list_contacts': {
        // STAGING-ONLY here for the demo: report usage after a (would-be)
        // provider call. Shows env.SPRIGR.usage.report.
        return stagingOnly(async () => {
          await env.SPRIGR.usage.report({ billedTokens: 1, kind: 'list_contacts' });
          return { contacts: [], note: 'On the platform this pages api.acme.example.' };
        }, 'list_contacts reports usage via env.SPRIGR.usage.report — publish to staging.');
      }

      default:
        return { ok: false, reason: `Unknown action: ${String((args as { action?: unknown }).action)}` };
    }
  } catch (err) {
    if (err instanceof AcmeApiError) return { ok: false, reason: err.message };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export default {
  showcase: async (args: DispatcherArgs, env: ShowcaseEnv) => runDispatcher(env, args),
};

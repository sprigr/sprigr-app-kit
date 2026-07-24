/**
 * Harvest - OAuth callback handler.
 *
 * The publisher-shared OAuth bouncer receives Harvest's redirect,
 * decodes `state` to find this install, and dispatches here with
 * { code, redirectUri }. Exchanges the code, persists tokens to
 * per-install D1, then resolves + stores the granted Harvest account
 * id (api.harvestapp.com requires a `Harvest-Account-Id` header on
 * every call).
 */

import { completeOAuthCallback } from '../lib/oauth';
import { listAccounts, ACCOUNT_ID_SETTING, ACCOUNT_NAME_SETTING } from '../lib/harvest';
import { requireClientId, requireClientSecret } from '../lib/env';
import { setSetting } from '../lib/store';
import type { HarvestEnv } from '../lib/env';

interface CallbackArgs {
  code: string;
  redirectUri: string;
}

type CallbackResult = { ok: true; account?: string } | { ok: false; reason: string };

export async function runOAuthCallback(env: HarvestEnv, args: CallbackArgs): Promise<CallbackResult> {
  try {
    await completeOAuthCallback({
      db: env.DB,
      clientId: requireClientId(env),
      clientSecret: requireClientSecret(env),
      code: args.code,
      redirectUri: args.redirectUri,
    });

    // Resolve which Harvest account this grant covers. A Harvest ID user
    // can belong to several accounts; the consent screen scopes the grant
    // to one (or all). We store the first Harvest-product account and use
    // it for every API call.
    const accounts = await listAccounts(env);
    const account = accounts[0];
    if (!account) {
      return { ok: false, reason: 'OAuth succeeded but no Harvest account was granted.' };
    }
    await setSetting(env.DB, ACCOUNT_ID_SETTING, String(account.id));
    await setSetting(env.DB, ACCOUNT_NAME_SETTING, account.name);

    return { ok: true, account: account.name };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export default {
  harvest_oauth_callback: async (args: CallbackArgs, env: HarvestEnv) => runOAuthCallback(env, args),
};

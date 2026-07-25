/**
 * Showcase - connection lifecycle handlers.
 *
 *   showcase_oauth_callback  bouncer-driven OAuth callback (csrf verify +
 *                            token exchange + persist). Runs fully local
 *                            under `sprigr app dev` (the whole callback loop
 *                            is exercisable before first publish).
 *   showcase_inbound_import  provider-initiated (inbound) install target:
 *                            the platform hands the exchanged token here
 *                            after a workspace-initiated connect. Persists
 *                            the token, records the shared-webhook tenant
 *                            mapping, and kicks off the durable backfill.
 *   refresh_showcase_tokens  scheduled keep-warm token refresh.
 *
 * Token persistence uses the local D1 token store. Kicking off the backfill
 * job + registering the shared tenant are env.SPRIGR.* (staging-only).
 */

import { decodeState } from '@sprigr/apps-app-sdk';
import { tokens, getSetting, setSetting, deleteSetting, setInstallConfig } from '../lib/store';
import { registerSharedTenant } from './webhooks';
import { stagingOnly } from '../lib/env';
import { ACCOUNT_ID_SETTING, ACCOUNT_NAME_SETTING } from '../lib/acme';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

interface CallbackArgs {
  code: string;
  redirectUri: string;
  state?: string;
}

// ── showcase_oauth_callback (bouncer flow) ───────────────────────────────────
export async function runOAuthCallback(env: ShowcaseEnv, args: CallbackArgs): Promise<HandlerResult> {
  try {
    // Verify the csrf carried in the signed state blob against per-install D1.
    if (args.state) {
      const { csrf } = decodeState(args.state) as { csrf?: string };
      const expected = await getSetting(env.DB, 'oauth_csrf');
      if (!expected || !csrf || csrf !== expected) {
        return { ok: false, reason: 'csrf mismatch (expired or replayed consent link)' };
      }
      await deleteSetting(env.DB, 'oauth_csrf');
    }
    // On the platform this exchanges the code at auth.acme.example. Stubbed so
    // local dev completes the whole loop; a real exchange is completeOAuthCallback
    // from @sprigr/apps-oauth-utils (see harvest's src/lib/oauth.ts).
    await tokens(env.DB).put('access_token', `acme-access-${args.code}`);
    await setSetting(env.DB, ACCOUNT_ID_SETTING, 'acct_local');
    await setSetting(env.DB, ACCOUNT_NAME_SETTING, 'Acme Workspace (local)');
    return { ok: true, result: { connected: true, account: 'Acme Workspace (local)' } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── showcase_inbound_import (provider-initiated install) ──────────────────────
interface InboundImportArgs {
  access_token: string;
  refresh_token?: string;
  external_id?: string;
}
export async function runInboundImport(env: ShowcaseEnv, args: InboundImportArgs): Promise<HandlerResult> {
  // Persist the platform-exchanged token in the app's own D1 schema.
  await tokens(env.DB).put('access_token', args.access_token);
  if (args.refresh_token) await tokens(env.DB).put('refresh_token', args.refresh_token);
  if (args.external_id) {
    await setSetting(env.DB, ACCOUNT_ID_SETTING, args.external_id);
    // Record the shared-webhook tenant mapping (local + staging registerWebhookTenant).
    await registerSharedTenant(env, args.external_id);
  }
  // Cache the install's config override locally (install-config pattern).
  await setInstallConfig(env.DB, 'connected_via', 'inbound');

  // STAGING-ONLY: kick off the durable backfill job.
  const started = await stagingOnly(
    () => env.SPRIGR.jobs.start({ name: 'showcase_backfill', params: { max_pages: 3 }, idempotencyKey: `backfill:${args.external_id ?? 'default'}` }),
    'runInboundImport starts the durable backfill via env.SPRIGR.jobs.start — publish to staging.',
  );
  return { ok: true, result: { imported: true, external_id: args.external_id, backfill: started } };
}

// ── refresh_showcase_tokens (scheduled) ──────────────────────────────────────
export async function runRefreshTokens(env: ShowcaseEnv): Promise<HandlerResult> {
  const refresh = await tokens(env.DB).get('refresh_token');
  if (!refresh) return { ok: true, result: { refreshed: false, reason: 'no refresh token stored' } };
  // On the platform: exchange refresh_token at auth.acme.example, then re-store.
  await tokens(env.DB).put('access_token', `acme-access-refreshed-${Date.now()}`);
  return { ok: true, result: { refreshed: true } };
}

export default {
  showcase_oauth_callback: (args: CallbackArgs, env: ShowcaseEnv) => runOAuthCallback(env, args),
  showcase_inbound_import: (args: InboundImportArgs, env: ShowcaseEnv) => runInboundImport(env, args),
  refresh_showcase_tokens: (_args: unknown, env: ShowcaseEnv) => runRefreshTokens(env),
};

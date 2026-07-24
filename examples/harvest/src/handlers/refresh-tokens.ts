/**
 * Harvest - scheduled token refresh (manifest schedules[] -> this tool).
 *
 * Harvest rotates refresh tokens; the cron keeps the stored pair warm so
 * a long-idle install can still refresh when an agent finally calls a
 * tool. getValidAccessToken (inside accessToken) is a no-op while the
 * cached access token is still fresh, so firing every 45 minutes is cheap.
 */

import { accessToken } from '../lib/harvest';
import { OAuthError } from '@sprigr/apps-oauth-utils';
import type { HarvestEnv } from '../lib/env';

type RefreshResult =
  | { ok: true }
  | { ok: false; reason: string; reconnect_required: boolean };

export async function runRefresh(env: HarvestEnv): Promise<RefreshResult> {
  try {
    await accessToken(env);
    return { ok: true };
  } catch (err) {
    // Report, never throw: a failed fire audits as an error either way,
    // and terminal failures (revoked grant) need a human reconnect, not
    // a crash loop.
    const reconnect = err instanceof OAuthError && err.terminal;
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      reconnect_required: reconnect,
    };
  }
}

export default {
  refresh_harvest_tokens: async (_args: Record<string, never>, env: HarvestEnv) => runRefresh(env),
};

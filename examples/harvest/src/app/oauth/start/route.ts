/**
 * GET /oauth/start
 *
 * Initiates the OAuth flow: mints a CSRF token (stashed in D1 so the
 * callback can verify), packs install_id + CSRF into `state`, and
 * redirects the user to Harvest's authorize URL with the publisher-
 * shared bouncer as redirect_uri.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { buildAuthorizeUrl } from '../../../lib/oauth';
import { setSetting } from '../../../lib/store';
import { encodeState, randomHex } from '@sprigr/apps-app-sdk';
import { requireClientId } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { env } = await getCloudflareContext({ async: true });
  const url = new URL(req.url);
  const returnTo = url.searchParams.get('return_to') ?? undefined;
  const installId = env.INSTALL_ID ?? 'unknown';

  // Refuse to restart a completed flow unless explicitly asked
  // (?reconnect=1): a drive-by GET must not clobber a pending csrf or
  // needlessly re-arm the flow once connected.
  const wantsReconnect = url.searchParams.get('reconnect') === '1';
  if (!wantsReconnect) {
    const connected = await env.DB
      .prepare("SELECT value FROM harvest_secrets WHERE key = 'access_token'")
      .bind()
      .first<{ value: string }>();
    if (connected?.value) {
      return NextResponse.redirect(new URL('/', req.url), 303);
    }
  }

  const csrf = randomHex(16);
  await setSetting(env.DB, 'oauth_csrf', csrf);

  // The bouncer is auto-detected from the request hostname so the same
  // bundle works on prod and staging. Override with HARVEST_REDIRECT_URI
  // for single-install development setups.
  const isStaging = req.url.includes('staging-apps.sprigr.com') || req.url.includes('staging-team.sprigr.com');
  const defaultBouncer = isStaging
    ? 'https://staging-oauth-bouncer.sprigr.com/harvest/oauth/callback'
    : 'https://oauth-bouncer.sprigr.com/harvest/oauth/callback';
  const redirectUri = process.env.HARVEST_REDIRECT_URI ?? defaultBouncer;

  const state = encodeState({
    installId,
    csrf,
    returnTo,
    iat: Date.now(),
  });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: requireClientId(env),
    redirectUri,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}

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
import { encodeState, randomHex } from '../../../lib/vendor/app-sdk';
import { requireClientId } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { env } = await getCloudflareContext({ async: true });
  const url = new URL(req.url);
  const returnTo = url.searchParams.get('return_to') ?? undefined;
  const installId = env.INSTALL_ID ?? 'unknown';

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

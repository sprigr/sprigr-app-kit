/**
 * GET /oauth/start
 *
 * Initiates the OAuth flow via the publisher-shared bouncer: mints a CSRF
 * token (stashed in D1 so the callback can verify), packs install_id + CSRF
 * into `state`, and redirects to Acme's authorize URL with the bouncer as
 * redirect_uri. Same environment-aware bouncer detection as harvest.
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

  const wantsReconnect = url.searchParams.get('reconnect') === '1';
  if (!wantsReconnect) {
    const connected = await env.DB
      .prepare("SELECT value FROM showcase_secrets WHERE key = 'access_token'")
      .bind()
      .first<{ value: string }>();
    if (connected?.value) {
      return NextResponse.redirect(new URL('/', req.url), 303);
    }
  }

  const csrf = randomHex(16);
  await setSetting(env.DB, 'oauth_csrf', csrf);

  const isStaging =
    req.url.includes('staging-apps.sprigr.com') || req.url.includes('staging-team.sprigr.com');
  const defaultBouncer = isStaging
    ? 'https://staging-oauth-bouncer.sprigr.com/showcase/oauth/callback'
    : 'https://oauth-bouncer.sprigr.com/showcase/oauth/callback';
  const redirectUri = process.env.SHOWCASE_REDIRECT_URI ?? defaultBouncer;

  const state = encodeState({ installId, csrf, returnTo, iat: Date.now() });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: requireClientId(env),
    redirectUri,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}

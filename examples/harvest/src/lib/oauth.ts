/**
 * Harvest - OAuth flow primitives.
 *
 * OAuth runs through the publisher-shared bouncer
 * (oauth-bouncer.sprigr.com / staging-oauth-bouncer.sprigr.com): one
 * redirect URI per environment, registered once on the Harvest
 * developer app. The bouncer decodes `state`, finds this install via
 * the WFP DISPATCHER, and dispatches into the `harvest_oauth_callback`
 * handler.
 */

import { exchangeAndPersist, type ProviderConfig, type AuthCodeResponse } from './vendor/oauth-utils';
import { tokens } from './store';
import type { D1Like } from './vendor/app-sdk';

// Harvest ID OAuth2 endpoints.
// https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/
export const AUTHORIZE_URL = 'https://id.getharvest.com/oauth2/authorize';
export const TOKEN_URL = 'https://id.getharvest.com/api/v2/oauth2/token';

export function providerConfig(clientId: string, clientSecret: string): ProviderConfig {
  return {
    provider: 'harvest',
    tokenUrl: TOKEN_URL,
    clientId,
    clientSecret,
  };
}

/** Build the authorize URL for the "Connect Harvest" button. */
export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    // No extra params: Harvest scopes access to the account(s) the user
    // picks on the consent screen; the granted account ids come back on
    // the token response / accounts endpoint, not via a `scope` request.
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Exchange an authorization code for tokens and persist to D1. */
export async function completeOAuthCallback(args: {
  db: D1Like;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<AuthCodeResponse> {
  const store = tokens(args.db);
  const config = providerConfig(args.clientId, args.clientSecret);
  return exchangeAndPersist(config, store, args.code, { redirectUri: args.redirectUri });
}

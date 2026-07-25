/**
 * Showcase - OAuth authorize-URL builder for the fictional Acme CRM.
 *
 * The token exchange itself would use completeOAuthCallback from
 * @sprigr/apps-oauth-utils (see harvest's src/lib/oauth.ts for the real
 * shape). This file only builds the authorize redirect the /oauth/start
 * route sends the user to.
 */

export const AUTHORIZE_URL = 'https://auth.acme.example/oauth/authorize';
export const TOKEN_URL = 'https://auth.acme.example/oauth/token';

export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('scope', 'contacts.read deals.read');
  u.searchParams.set('state', args.state);
  return u.toString();
}

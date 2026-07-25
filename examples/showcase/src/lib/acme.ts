/**
 * Showcase - fake "Acme CRM" provider client.
 *
 * A stand-in for a real third-party API (api.acme.example). The kit ships
 * this so the sample handlers have something concrete to call; it is NOT a
 * real service. Real apps replace this with their provider's SDK / fetch
 * calls (see harvest's src/lib/harvest.ts for a real-shaped example).
 */

import { getSetting } from './store';
import type { ShowcaseEnv } from './env';

export const ACCOUNT_ID_SETTING = 'acme_account_id';
export const ACCOUNT_NAME_SETTING = 'acme_account_name';
export const ACME_API_BASE = 'https://api.acme.example/v1';

export interface AcmeContact {
  id: string;
  name: string;
  email: string;
  company: string;
  stage: string;
  owner: string;
  source: string;
}

export class AcmeApiError extends Error {}

/** Guard used by list/get actions: no token means "not connected yet". */
export async function requireConnected(env: ShowcaseEnv): Promise<string> {
  const accountId = await getSetting(env.DB, ACCOUNT_ID_SETTING);
  if (!accountId) {
    throw new AcmeApiError('No Acme account linked. Open the app settings page and click "Connect Acme".');
  }
  return accountId;
}

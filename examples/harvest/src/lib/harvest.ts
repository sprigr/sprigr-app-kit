/**
 * Harvest API v2 client.
 *
 * Every data call goes to https://api.harvestapp.com/v2 and needs three
 * headers: the OAuth bearer, `Harvest-Account-Id` (one Harvest ID login
 * can span several accounts; the callback stores the granted one in
 * settings), and a `User-Agent` (Harvest rejects agentless clients).
 *
 * Token freshness is delegated to the vendored oauth-utils
 * `getValidAccessToken` (race-safe refresh rotation against
 * id.getharvest.com; Harvest rotates the refresh token on every
 * refresh, which refreshAndPersist handles by persisting the new
 * refresh_token first).
 */

import { getValidAccessToken } from '@sprigr/apps-oauth-utils';
import { fetchWithRetry } from '@sprigr/apps-app-sdk';
import { providerConfig } from './oauth';
import { tokens, getSetting } from './store';
import { requireClientId, requireClientSecret } from './env';
import type { HarvestEnv } from './env';

export const API_BASE = 'https://api.harvestapp.com/v2';
export const ACCOUNTS_URL = 'https://id.getharvest.com/api/v2/accounts';
const USER_AGENT = 'Sprigr Harvest App (platform@sprigr.com)';

export const ACCOUNT_ID_SETTING = 'harvest_account_id';
export const ACCOUNT_NAME_SETTING = 'harvest_account_name';

export class HarvestApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'HarvestApiError';
  }
}

export async function accessToken(env: HarvestEnv): Promise<string> {
  const config = providerConfig(requireClientId(env), requireClientSecret(env));
  return getValidAccessToken(config, tokens(env.DB));
}

/**
 * List the Harvest accounts the connected user granted access to.
 * Lives on id.getharvest.com (no Harvest-Account-Id header).
 */
export async function listAccounts(
  env: HarvestEnv,
): Promise<Array<{ id: number; name: string; product: string }>> {
  const token = await accessToken(env);
  const res = await fetchWithRetry(ACCOUNTS_URL, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new HarvestApiError(res.status, body, `Harvest accounts lookup failed (${res.status})`);
  }
  const data = (await res.json()) as {
    accounts?: Array<{ id: number; name: string; product: string }>;
  };
  return (data.accounts ?? []).filter((a) => a.product === 'harvest');
}

/** Authenticated call against api.harvestapp.com/v2. */
export async function harvestFetch<T>(
  env: HarvestEnv,
  path: string,
  init?: { method?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown },
): Promise<T> {
  const accountId = await getSetting(env.DB, ACCOUNT_ID_SETTING);
  if (!accountId) {
    throw new HarvestApiError(
      0,
      '',
      'No Harvest account linked. Open the app settings page and click "Connect Harvest" first.',
    );
  }
  const token = await accessToken(env);

  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const method = init?.method ?? 'GET';
  // Retry only idempotent reads: a retried POST after an ambiguous 5xx
  // could double-create a time entry.
  const doFetch = method === 'GET' ? fetchWithRetry : fetch;
  const res = await doFetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Harvest-Account-Id': accountId,
      'User-Agent': USER_AGENT,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new HarvestApiError(
      res.status,
      body,
      `Harvest API ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as T;
}

// ---- typed endpoint wrappers -------------------------------------------

export interface Paged {
  page?: number;
  per_page?: number;
}

export function listClients(env: HarvestEnv, args: Paged & { is_active?: boolean } = {}) {
  return harvestFetch<{
    clients: Array<Record<string, unknown>>;
    total_entries: number;
    page: number;
    total_pages: number;
  }>(env, '/clients', { query: { ...args } });
}

export function listProjects(
  env: HarvestEnv,
  args: Paged & { client_id?: number; is_active?: boolean } = {},
) {
  return harvestFetch<{
    projects: Array<Record<string, unknown>>;
    total_entries: number;
    page: number;
    total_pages: number;
  }>(env, '/projects', { query: { ...args } });
}

export function listTaskAssignments(env: HarvestEnv, projectId: number, args: Paged = {}) {
  return harvestFetch<{
    task_assignments: Array<Record<string, unknown>>;
    total_entries: number;
    page: number;
    total_pages: number;
  }>(env, `/projects/${projectId}/task_assignments`, { query: { is_active: true, ...args } });
}

export function listTimeEntries(
  env: HarvestEnv,
  args: Paged & {
    project_id?: number;
    client_id?: number;
    user_id?: number;
    from?: string;
    to?: string;
  } = {},
) {
  return harvestFetch<{
    time_entries: Array<Record<string, unknown>>;
    total_entries: number;
    page: number;
    total_pages: number;
  }>(env, '/time_entries', { query: { ...args } });
}

export function createTimeEntry(
  env: HarvestEnv,
  args: { project_id: number; task_id: number; spent_date: string; hours?: number; notes?: string },
) {
  return harvestFetch<{ id: number; [key: string]: unknown }>(env, '/time_entries', {
    method: 'POST',
    body: args,
  });
}

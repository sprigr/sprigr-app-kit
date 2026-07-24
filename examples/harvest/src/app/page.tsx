/**
 * Harvest - per-install settings UI (SSR).
 *
 * This is the manifest `runtime.entry`: what a tenant sees when they
 * open the app from the Sprigr portal. Shows connection status and the
 * "Connect Harvest" entry point. Served on the public install host with
 * no per-request auth, so it discloses only coarse state (connected or
 * not + account name), never tokens or ids.
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSetting } from '../lib/store';
import { ACCOUNT_ID_SETTING, ACCOUNT_NAME_SETTING } from '../lib/harvest';

export const dynamic = 'force-dynamic';

interface PageState {
  connected: boolean;
  accountName: string | null;
  error: boolean;
}

async function loadState(): Promise<PageState> {
  // Try-catch: on a cold install the per-install D1 may not have
  // migrations applied yet; the page must still render.
  try {
    const { env } = await getCloudflareContext({ async: true });
    const accountId = await getSetting(env.DB, ACCOUNT_ID_SETTING);
    const accountName = await getSetting(env.DB, ACCOUNT_NAME_SETTING);
    return { connected: Boolean(accountId), accountName, error: false };
  } catch {
    return { connected: false, accountName: null, error: true };
  }
}

export default async function Page() {
  const state = await loadState();
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>Harvest</h1>
      <p style={{ color: '#555' }}>
        Connect your Harvest account so agents can list clients and projects, read logged time,
        and create time entries on your behalf.
      </p>
      <h2>Connection status</h2>
      {state.error && (
        <p style={{ background: '#fff0f0', padding: 12, color: '#811', borderRadius: 8 }}>
          Could not load connection status yet. If this install is brand new, wait a minute for
          provisioning to finish and reload.
        </p>
      )}
      {!state.error && state.connected && (
        <p style={{ background: '#f0fff4', padding: 12, color: '#164', borderRadius: 8 }}>
          Connected to Harvest account <strong>{state.accountName ?? '(unnamed)'}</strong>. Agents
          can now use the <code>harvest</code> tool. Reconnect below to switch accounts.
        </p>
      )}
      {!state.error && !state.connected && (
        <p style={{ color: '#888' }}>Not connected yet.</p>
      )}
      <p>
        <a
          href="oauth/start"
          style={{
            display: 'inline-block',
            padding: '10px 18px',
            background: '#f36c00',
            color: '#fff',
            borderRadius: 8,
            textDecoration: 'none',
          }}
        >
          {state.connected ? 'Reconnect Harvest' : 'Connect Harvest'}
        </a>
      </p>
      <h2>What agents can do</h2>
      <ul style={{ color: '#555', lineHeight: 1.7 }}>
        <li>List clients and projects</li>
        <li>List time entries (by project, client, person, or date range)</li>
        <li>Log new time entries (or start a running timer)</li>
      </ul>
    </main>
  );
}

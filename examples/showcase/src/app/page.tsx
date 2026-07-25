/**
 * Showcase - per-install settings UI (SSR). The manifest `runtime.entry`.
 * Shows connection status + the "Connect Acme" entry point. Coarse state
 * only (never tokens/ids), like harvest.
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSetting } from '../lib/store';
import { ACCOUNT_ID_SETTING, ACCOUNT_NAME_SETTING } from '../lib/acme';

export const dynamic = 'force-dynamic';

interface PageState {
  connected: boolean;
  accountName: string | null;
  error: boolean;
}

async function loadState(): Promise<PageState> {
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
      <h1 style={{ marginTop: 0 }}>Showcase</h1>
      <p style={{ color: '#555' }}>
        A synthetic every-feature reference app. Connect the fictional Acme CRM to exercise the
        tool, webhook, channel, schedule, job, event, and data-index surfaces documented in the
        capability cookbook.
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
          Connected to Acme workspace <strong>{state.accountName ?? '(unnamed)'}</strong>.
        </p>
      )}
      {!state.error && !state.connected && <p style={{ color: '#888' }}>Not connected yet.</p>}
      <p>
        <a
          href="oauth/start"
          style={{
            display: 'inline-block',
            padding: '10px 18px',
            background: '#5a7a4a',
            color: '#fff',
            borderRadius: 8,
            textDecoration: 'none',
          }}
        >
          {state.connected ? 'Reconnect Acme' : 'Connect Acme'}
        </a>
      </p>
    </main>
  );
}

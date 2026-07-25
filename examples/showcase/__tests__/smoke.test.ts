/**
 * Showcase smoke tests — one describe block per handler capability group.
 *
 * Two assertion styles:
 *   - D1-local paths (connection_status, csrf, dedup, sync_state) run for
 *     real against the in-memory fakeDb.
 *   - env.SPRIGR.* paths are asserted TWO ways:
 *       (a) with fakeSprigr — proves the handler makes the exact call
 *           (method name + args) it should;
 *       (b) with fakeSprigrThrowing (the `sprigr app dev` proxy) — proves
 *           stagingOnly() catches the throw and returns { staging_only: true }.
 */

import { describe, it, expect } from 'vitest';
import { fakeSprigr, fakeSprigrThrowing, makeEnv } from './__helpers__/fake-env';
import { hmacSha256Hex, bytesToBase64 } from '@sprigr/apps-app-sdk';

import { runDispatcher } from '../src/handlers/dispatcher';
import { onContact, onDeal, onBookmarklet, onShared } from '../src/handlers/webhooks';
import { runBackfillStep } from '../src/handlers/jobs';
import { onDealWon } from '../src/handlers/events';
import { receive, send, identity } from '../src/handlers/channel';
import { runOAuthCallback, runInboundImport, runRefreshTokens } from '../src/handlers/config';
import { dailyDigest, tenantRollup, routeDecision } from '../src/handlers/platform';
import { saveCursor, loadCursor, readPublisherSecretRef } from '../src/handlers/store';
import { fetchRenderedPage, screenshotPage } from '../src/handlers/browser';
import {
  cacheContacts,
  searchContacts,
  defineDealsCollection,
  reconcileDeals,
  registerWarehouse,
  renameWarehouse,
  deregisterWarehouse,
} from '../src/handlers/data-and-collections';
import {
  startBackfill,
  getBackfill,
  listBackfills,
  cancelBackfill,
  approveBackfill,
} from '../src/handlers/jobs';
import { putReportCsv, reportUrl } from '../src/handlers/files';
import { pingHelloMarketplace, correlateShopifyOrder, registerChatWorkspace } from '../src/handlers/cross-tenant';
import { encodeState } from '@sprigr/apps-app-sdk';

async function hmacBase64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToBase64(new Uint8Array(sig));
}

describe('dispatcher (agent tool)', () => {
  it('connection_status reads per-install D1 (local)', async () => {
    const res = await runDispatcher(makeEnv(), { action: 'connection_status' });
    expect(res).toEqual({ ok: true, result: { connected: false, hint: expect.stringContaining('Connect Acme') } });
  });

  it('get_contact validates args + connection guard (local)', async () => {
    const missing = await runDispatcher(makeEnv(), { action: 'get_contact' });
    expect(missing.ok).toBe(false);
    const notConnected = await runDispatcher(makeEnv(), { action: 'get_contact', contact_id: 'c1' });
    expect(notConnected.ok).toBe(false);
    if (!notConnected.ok && 'reason' in notConnected) expect(notConnected.reason).toMatch(/No Acme account linked/);
  });

  it('rejects unknown actions', async () => {
    const res = await runDispatcher(makeEnv(), { action: 'frobnicate' as never });
    expect(res.ok).toBe(false);
  });

  it('cache_contact calls data.import + emit with the right shapes', async () => {
    const { host, calls } = fakeSprigr();
    const res = await runDispatcher(makeEnv({ SPRIGR: host }), {
      action: 'cache_contact',
      contact_id: 'c_1',
      name: 'Acme Lead',
      stage: 'won',
    });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['data.import', 'emit']);
    expect(calls[0]!.args[0]).toEqual([
      { objectID: 'c_1', name: 'Acme Lead', email: '', company: '', stage: 'won', owner: '', source: 'manual' },
    ]);
    expect(calls[1]!.args).toEqual(['showcase.contact.cached', { contact_id: 'c_1' }]);
  });

  it('search_cached_contacts returns staging_only under the dev stub', async () => {
    const res = await runDispatcher(makeEnv({ SPRIGR: fakeSprigrThrowing() }), {
      action: 'search_cached_contacts',
      query: 'acme',
    });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('data.search') });
  });
});

describe('webhooks', () => {
  it('onContact verifies hmac-hex, dedups, then caches (staging)', async () => {
    const env = makeEnv({ SPRIGR: fakeSprigrThrowing() });
    const body = JSON.stringify({ contact: { id: 'c_9', name: 'X' } });
    const sig = await hmacSha256Hex(env.ACME_WEBHOOK_SECRET, body);
    const res = await onContact(env, { body, headers: { 'x-acme-signature-256': sig, 'x-acme-delivery': 'd1' } });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('data.import') });
  });

  it('onContact rejects a bad signature', async () => {
    const res = await onContact(makeEnv(), { body: '{}', headers: { 'x-acme-signature-256': 'nope' } });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('onContact dedups a re-delivery with the same delivery id', async () => {
    const env = makeEnv(); // shared DB across both calls
    const body = JSON.stringify({ contact: { id: 'c_9' } });
    const sig = await hmacSha256Hex(env.ACME_WEBHOOK_SECRET, body);
    const headers = { 'x-acme-signature-256': sig, 'x-acme-delivery': 'dup1' };
    // First delivery claims (then hits the staging stub); swap to recording SPRIGR.
    const { host } = fakeSprigr();
    env.SPRIGR = host;
    await onContact(env, { body, headers });
    const second = await onContact(env, { body, headers });
    expect(second).toEqual({ ok: true, result: { deduped: true } });
  });

  it('onDeal verifies hmac-base64 then emits (staging)', async () => {
    const env = makeEnv({ SPRIGR: fakeSprigrThrowing() });
    const body = JSON.stringify({ deal: { id: 'd_1', contact_id: 'c_1', amount: 500 } });
    const sig = await hmacBase64(env.ACME_WEBHOOK_SECRET, body);
    const res = await onDeal(env, { body, headers: { 'x-acme-signature': sig, 'x-acme-delivery': 'x1' } });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('emit') });
  });

  it('onBookmarklet trusts the platform install-token verification header', async () => {
    const res = await onBookmarklet(makeEnv(), {
      body: JSON.stringify({ contact_id: 'c_5' }),
      headers: { 'x-sprigr-install-verified': 'true', 'x-sprigr-install-id': 'inst_test' },
    });
    expect(res).toEqual({ ok: true, result: { queued: 'c_5', install: 'inst_test' } });
  });

  it('onShared verifies the re-signed publisher secret', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ workspaceId: 'ws_1', events: [1, 2] });
    const sig = await hmacSha256Hex(env.ACME_SHARED_WEBHOOK_SECRET, body);
    const res = await onShared(env, { body, headers: { 'x-acme-signature-256': sig } });
    expect(res).toEqual({ ok: true, result: { workspace: 'ws_1', events: 2 } });
  });
});

describe('durable job step function', () => {
  it('sleeps between pages while backfilling', async () => {
    const res = await runBackfillStep(makeEnv(), {
      job: { id: 'j1', name: 'showcase_backfill', step: 0, attempt: 0, params: { max_pages: 3 }, state: {} },
    });
    expect(res.op).toBe('sleep');
    if (res.op === 'sleep') expect(res.state?.phase).toBe('backfill');
  });

  it('waits for operator approval after the last page', async () => {
    const res = await runBackfillStep(makeEnv(), {
      job: { id: 'j1', name: 'showcase_backfill', step: 3, attempt: 0, params: { max_pages: 1 }, state: { phase: 'backfill', pagesWalked: 0 } },
    });
    expect(res.op).toBe('wait');
  });

  it('continues to done when approved, then completes', async () => {
    const approved = await runBackfillStep(makeEnv(), {
      job: { id: 'j1', name: 'showcase_backfill', step: 4, attempt: 0, state: { phase: 'await_approval', pagesWalked: 1, rowsSeen: 2 }, signal: { payload: { approved: true } } },
    });
    expect(approved.op).toBe('continue');
    const done = await runBackfillStep(makeEnv(), {
      job: { id: 'j1', name: 'showcase_backfill', step: 5, attempt: 0, state: { phase: 'done', pagesWalked: 1, rowsSeen: 2 } },
    });
    expect(done).toEqual({ op: 'complete', result: { pagesWalked: 1, rowsSeen: 2 } });
  });

  it('fails (non-retryable) when the operator rejects', async () => {
    const res = await runBackfillStep(makeEnv(), {
      job: { id: 'j1', name: 'showcase_backfill', step: 4, attempt: 0, state: { phase: 'await_approval' }, signal: { payload: { approved: false } } },
    });
    expect(res).toEqual({ op: 'fail', error: 'operator rejected the backfill', retryable: false });
  });
});

describe('event subscription', () => {
  it('dedups on eventId, then caches (staging)', async () => {
    const env = makeEnv({ SPRIGR: fakeSprigrThrowing() });
    const res = await onDealWon(env, { event: 'showcase.deal.won', eventId: 'e1', payload: { contact_id: 'c_1', amount: 9 } });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('data.import') });
  });
});

describe('channels', () => {
  it('receive echoes a url-verification challenge', async () => {
    const res = await receive(makeEnv(), { body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }) });
    expect(res).toEqual({ challenge: 'abc' });
  });

  it('receive decodes a signed inbound message', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ event: { user: 'u1', text: 'hi', thread_ts: 't1' } });
    const sig = await hmacSha256Hex(env.ACME_WEBHOOK_SECRET, body);
    const res = await receive(env, { body, headers: { 'x-acme-chat-signature': sig } });
    expect(res).toEqual({ kind: 'message', externalUserId: 'u1', text: 'hi', threadId: 't1' });
  });

  it('send fails without a stored token', async () => {
    const res = await send(makeEnv(), { externalUserId: 'u1', text: 'hi' });
    expect(res).toEqual({ ok: false, reason: 'Acme Chat not connected' });
  });

  it('identity maps the user id (inbox append is staging-only)', async () => {
    const res = await identity(makeEnv({ SPRIGR: fakeSprigrThrowing() }), { externalUserId: 'u1' });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { identity: string }).identity).toBe('acme:u1');
  });
});

describe('connection lifecycle', () => {
  it('oauth callback verifies csrf against D1 and persists tokens (local)', async () => {
    const env = makeEnv();
    // Seed csrf as the /oauth/start route would.
    await env.DB.prepare('INSERT INTO showcase_settings (key, value) VALUES (?, ?)').bind('oauth_csrf', 'csrf-1').run();
    const state = encodeState({ installId: 'inst_test', csrf: 'csrf-1', iat: Date.now() });
    const res = await runOAuthCallback(env, { code: 'abc', redirectUri: 'https://x/cb', state });
    expect(res).toEqual({ ok: true, result: { connected: true, account: 'Acme Workspace (local)' } });
  });

  it('oauth callback rejects a mismatched csrf', async () => {
    const env = makeEnv();
    const state = encodeState({ installId: 'inst_test', csrf: 'wrong', iat: Date.now() });
    const res = await runOAuthCallback(env, { code: 'abc', redirectUri: 'https://x/cb', state });
    expect(res.ok).toBe(false);
  });

  it('inbound import persists token, records tenant, starts backfill (staging)', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    const res = await runInboundImport(env, { access_token: 'tok', external_id: 'ws_9' });
    expect(res.ok).toBe(true);
    // registerWebhookTenant + jobs.start both fire through env.SPRIGR.
    expect(calls.map((c) => c.method).sort()).toEqual(['jobs.start', 'registerWebhookTenant']);
  });

  it('refresh tokens no-ops with no refresh token', async () => {
    const res = await runRefreshTokens(makeEnv());
    expect(res).toEqual({ ok: true, result: { refreshed: false, reason: 'no refresh token stored' } });
  });
});

describe('platform-driven handlers', () => {
  it('dailyDigest reports usage + creates a follow-up schedule', async () => {
    const { host, calls } = fakeSprigr();
    const res = await dailyDigest(makeEnv({ SPRIGR: host }), { name: 'showcase_daily_digest', scheduled_at: '2026-07-25' });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['usage.report', 'schedules.create']);
    expect(calls[0]!.args[0]).toEqual({ billedTokens: 5, kind: 'daily_digest' });
  });

  it('tenantRollup queries the data index (staging)', async () => {
    const res = await tenantRollup(makeEnv({ SPRIGR: fakeSprigrThrowing() }), { name: 'showcase_tenant_rollup' });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('data.search') });
  });

  it('routeDecision falls back to round-robin when no workflow configured (local)', async () => {
    const res = await routeDecision(makeEnv(), { contact_id: 'c_1', stage: 'new' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { owner: string; source: string };
      expect(r.source).toBe('default');
      expect(['alex', 'blake', 'casey']).toContain(r.owner);
    }
  });

  it('routeDecision calls run_workflow when configured', async () => {
    const env = makeEnv();
    await env.DB.prepare('INSERT INTO showcase_install_config (key, value) VALUES (?, ?)').bind('decision_route_decision_workflow_id', 'wf_123').run();
    const { host, calls } = fakeSprigr({ run_workflow: { ok: true, output: { owner: 'dana' } } });
    env.SPRIGR = host;
    const res = await routeDecision(env, { contact_id: 'c_1' });
    expect(calls[0]!.method).toBe('run_workflow');
    expect(calls[0]!.args[0]).toBe('wf_123');
    if (res.ok) expect((res.result as { owner: string }).owner).toBe('dana');
  });
});

describe('env.SPRIGR reference modules (call-shape assertions)', () => {
  it('store.* uses company scope + ttl', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await saveCursor(env, 'cur1');
    await loadCursor(env);
    await readPublisherSecretRef(env);
    expect(calls[0]).toEqual({ method: 'store.put', args: ['sync:cursor', 'cur1', { scope: 'company', ttlSeconds: 86400 }] });
    expect(calls[1]).toEqual({ method: 'store.get', args: ['sync:cursor', { scope: 'company' }] });
    expect(calls[2]).toEqual({ method: 'store.get', args: ['shared:acme_session', { scope: 'publisher' }] });
  });

  it('browser.fetch/screenshot pass the documented opts', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await fetchRenderedPage(env, 'https://acme.example/x');
    await screenshotPage(env, 'https://acme.example/x');
    expect(calls[0]!.method).toBe('browser.fetch');
    expect((calls[0]!.args[1] as { waitForSelector: string }).waitForSelector).toBe('#app-root');
    expect(calls[1]).toEqual({ method: 'browser.screenshot', args: ['https://acme.example/x', { fullPage: true }] });
  });

  it('data + collections + fulfillment call shapes', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await cacheContacts(env, [{ id: 'c1', name: 'n', email: 'e', company: 'co', stage: 's', owner: 'o', source: 'src' }]);
    await searchContacts(env, 'q', 'won');
    await defineDealsCollection(env);
    await reconcileDeals(env, ['d1', 'd2']);
    await registerWarehouse(env, 'int_1', { key: 'wh-a', name: 'Warehouse A' });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(['data.import', 'data.search', 'collections.define', 'collections.reconcile', 'fulfillment_services.register']);
    expect((calls[0]!.args[0] as Array<{ objectID: string }>)[0]!.objectID).toBe('c1');
    expect((calls[4]!.args[0] as { serviceKey: string }).serviceKey).toBe('wh-a');
  });

  it('files.putStream/url call shapes', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await putReportCsv(env, 'reports/a.csv', 'a,b\n1,2');
    await reportUrl(env, 'reports/a.csv');
    expect(calls[0]!.method).toBe('files.putStream');
    expect((calls[0]!.args[2] as { contentType: string }).contentType).toBe('text/csv');
    expect(calls[1]).toEqual({ method: 'files.url', args: ['reports/a.csv', { expiresIn: 3600 }] });
  });

  it('cross-tenant: invoke / integrations.invoke / registerChannel', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await pingHelloMarketplace(env);
    await correlateShopifyOrder(env, 'int_shop');
    await registerChatWorkspace(env, 'team_1');
    expect(calls[0]).toEqual({ method: 'invoke', args: ['hello_ping_tool', { from: 'showcase' }] });
    expect(calls[1]!.method).toBe('integrations.invoke');
    expect((calls[1]!.args[0] as { tool: string }).tool).toBe('shopify_list_orders');
    expect(calls[2]).toEqual({ method: 'registerChannel', args: ['acme_chat', 'team_1'] });
  });
});

describe('job lifecycle (driving a durable job from outside the step fn)', () => {
  it('start/get/list/cancel/signal call shapes', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await startBackfill(env, '2026-01-01T00:00:00Z');
    await getBackfill(env, 'job_1');
    await listBackfills(env, 'running');
    await cancelBackfill(env, 'job_1');
    await approveBackfill(env, 'job_1', 'ops@acme.example');
    expect(calls.map((c) => c.method)).toEqual([
      'jobs.start',
      'jobs.get',
      'jobs.list',
      'jobs.cancel',
      'jobs.signal',
    ]);
    // idempotencyKey is what makes a double-click safe.
    const started = calls[0]!.args[0] as { name: string; idempotencyKey: string };
    expect(started.name).toBe('showcase_backfill');
    expect(started.idempotencyKey).toBe('backfill:2026-01-01T00:00:00Z');
    // list filters to this job name so other jobs don't leak into the UI.
    expect(calls[2]!.args[0]).toMatchObject({ name: 'showcase_backfill', status: 'running' });
    // the signal payload is what the parked step reads back.
    expect(calls[4]!.args[1]).toMatchObject({ approved: true });
  });
});

describe('fulfillment service mutation', () => {
  it('update keys off serviceKey and omits untouched flags', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await renameWarehouse(env, 'int_1', { key: 'wh-a', newName: 'Warehouse A (East)' });
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(calls[0]!.method).toBe('fulfillment_services.update');
    expect(req).toMatchObject({ serviceKey: 'wh-a', serviceName: 'Warehouse A (East)' });
    // Not passed => not sent, so the platform keeps the current value.
    expect('trackingSupport' in req).toBe(false);
  });

  it('update forwards an explicit flag change', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await renameWarehouse(env, 'int_1', { key: 'wh-a', newName: 'A', trackingSupport: false });
    expect(calls[0]!.args[0]).toMatchObject({ trackingSupport: false });
  });

  it('delete passes the full three-part key', async () => {
    const { host, calls } = fakeSprigr();
    const env = makeEnv({ SPRIGR: host });
    await deregisterWarehouse(env, 'int_1', 'wh-a');
    expect(calls[0]!.method).toBe('fulfillment_services.delete');
    expect(calls[0]!.args[0]).toEqual({ platform: 'shopify', integrationId: 'int_1', serviceKey: 'wh-a' });
  });
});

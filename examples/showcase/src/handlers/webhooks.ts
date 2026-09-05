/**
 * Showcase - inbound webhook receivers.
 *
 * Every entry is a manifest webhooks[] handler_tool (declared internal:true
 * so it's never agent-callable). The platform verifies the declared
 * signature BEFORE dispatch, so by the time a handler runs the caller is
 * already authenticated — but these handlers ALSO re-verify to show the
 * pattern (and because the shared webhook re-signs per tenant).
 *
 * Signature verification + dedup are pure/local (they run under
 * `sprigr app dev`). Anything that reacts downstream (emit, data.import,
 * registerWebhookTenant) is env.SPRIGR.* and therefore staging-only.
 *
 * Webhook dispatch args shape (from the platform + @sprigr/apps-app-sdk
 * WebhookArgs): { body: string; signature?: string; headers?: Record<string,string> }.
 */

import { hmacSha256Hex, constantTimeEqual, bytesToBase64 } from '@sprigr/apps-app-sdk';
import { makeDedupLatch } from '@sprigr/apps-dedup-latch';
import { makeWebhookRegistry } from '@sprigr/apps-webhook-registry';
import { stagingOnly } from '../lib/env';
import type { WebhookArgs } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

const DEDUP_TTL_SEC = 7 * 24 * 3600;

/** HMAC-SHA256 -> base64. Some providers send a base64 digest rather than
 *  hex; declare `signature.encoding: "base64"` and use this. The app-sdk
 *  only ships the hex variant. */
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

/** Pull a header case-insensitively (platform forwards lowercased). */
function header(args: WebhookArgs, name: string): string | undefined {
  const h = args.headers ?? {};
  return h[name.toLowerCase()] ?? h[name] ?? (name.toLowerCase() === 'x-sig' ? args.signature : undefined);
}

/** Dedup key: prefer a provider delivery id, else hash the body. */
async function dedupKey(args: WebhookArgs, headerName: string): Promise<string> {
  const delivery = header(args, headerName);
  if (delivery) return delivery;
  return `body:${await hmacSha256Hex('showcase-dedup', args.body)}`;
}

// ── /acme/contact — hmac hex, per install ───────────────────────────────────
export async function onContact(env: ShowcaseEnv, args: WebhookArgs): Promise<HandlerResult> {
  const provided = header(args, 'X-Acme-Signature-256') ?? args.signature ?? '';
  const expected = await hmacSha256Hex(env.ACME_WEBHOOK_SECRET, args.body);
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  // LOCAL: dedup against per-install D1.
  const latch = makeDedupLatch({ db: env.DB, table: 'showcase_webhook_dedup', ttlSec: DEDUP_TTL_SEC });
  const firstSeen = await latch.tryClaim(await dedupKey(args, 'X-Acme-Delivery'));
  if (!firstSeen) return { ok: true, result: { deduped: true } };

  const payload = JSON.parse(args.body) as { contact?: { id?: string } };
  const contactId = payload.contact?.id;
  if (!contactId) return { ok: false, reason: 'no contact id in body' };

  // STAGING-ONLY: cache the updated contact to the data index.
  return stagingOnly(
    () => env.SPRIGR.data.import([{ objectID: contactId, ...(payload.contact as object) }]),
    'onContact caches the contact via env.SPRIGR.data.import — publish to staging.',
  );
}

// ── /acme/deal — hmac base64, per install ───────────────────────────────────
export async function onDeal(env: ShowcaseEnv, args: WebhookArgs): Promise<HandlerResult> {
  const provided = header(args, 'X-Acme-Signature') ?? args.signature ?? '';
  const expected = await hmacSha256Base64(env.ACME_WEBHOOK_SECRET, args.body);
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  const latch = makeDedupLatch({ db: env.DB, table: 'showcase_webhook_dedup', ttlSec: DEDUP_TTL_SEC });
  if (!(await latch.tryClaim(await dedupKey(args, 'X-Acme-Delivery')))) {
    return { ok: true, result: { deduped: true } };
  }
  const payload = JSON.parse(args.body) as { deal?: { id?: string; contact_id?: string; amount?: number } };
  const deal = payload.deal ?? {};

  // STAGING-ONLY: emit a marketplace event a workflow_template / subscription
  // reacts to, then record the delivery outcome on the platform log. The log
  // line is the replacement for a per-webhook `<slug>_audit` D1 row: D1 bills
  // every row written, Analytics Engine does not, and the row is queryable
  // at /api/data/system-logs (category `showcase.webhook.ok`). Keep the
  // summary short and the varying parts in metadata; caps throw, never trim.
  return stagingOnly(
    async () => {
      const emitted = await env.SPRIGR.emit('showcase.deal.won', { deal_id: deal.id, contact_id: deal.contact_id, amount: deal.amount });
      await env.SPRIGR.log({
        level: 'info',
        category: 'webhook.ok',
        summary: `acme/deal ${deal.id ?? 'unknown'} emitted showcase.deal.won`,
        metadata: { deal_id: deal.id ?? null, bytes: args.body.length },
      });
      return emitted;
    },
    'onDeal emits showcase.deal.won via env.SPRIGR.emit and logs the delivery via env.SPRIGR.log: publish to staging.',
  );
}

// ── /acme/bookmarklet — install_token bearer scheme ─────────────────────────
export async function onBookmarklet(env: ShowcaseEnv, args: WebhookArgs): Promise<HandlerResult> {
  // The platform already verified the install-token bearer before dispatch
  // and forwards x-sprigr-install-verified: "true". Trust it, but log the
  // plumbing headers so authors see the contract.
  const verified = header(args, 'x-sprigr-install-verified');
  if (verified !== 'true') {
    return { ok: false, reason: 'expected platform install-token verification' };
  }
  const payload = JSON.parse(args.body) as { contact_id?: string };
  if (!payload.contact_id) return { ok: false, reason: 'no contact_id' };
  return { ok: true, result: { queued: payload.contact_id, install: header(args, 'x-sprigr-install-id') } };
}

// ── /acme/shared — app-level shared webhook, fanned out per tenant ───────────
export async function onShared(env: ShowcaseEnv, args: WebhookArgs): Promise<HandlerResult> {
  // The platform verified the publisher secret + re-signed the per-tenant
  // slice with the same secret before routing it here by workspaceId
  // (tenant_key). Re-verify the re-signed body.
  const provided = header(args, 'X-Acme-Signature-256') ?? args.signature ?? '';
  const expected = await hmacSha256Hex(env.ACME_SHARED_WEBHOOK_SECRET, args.body);
  if (!constantTimeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  const payload = JSON.parse(args.body) as { workspaceId?: string; events?: unknown[] };
  return { ok: true, result: { workspace: payload.workspaceId, events: (payload.events ?? []).length } };
}

/**
 * Called at connect time (not a webhook handler_tool) to map this install's
 * Acme workspace id onto the shared webhook, so the platform knows which
 * install receives a given tenant's slice. Records locally AND tells the
 * platform via env.SPRIGR.registerWebhookTenant.
 */
export async function registerSharedTenant(env: ShowcaseEnv, workspaceId: string): Promise<HandlerResult> {
  // LOCAL: record the mapping in D1.
  const reg = makeWebhookRegistry({ db: env.DB, table: 'showcase_webhook_tenants' });
  await reg.record(workspaceId, workspaceId, '/acme/shared');
  // STAGING-ONLY: tell the platform to route this tenant's slice here.
  return stagingOnly(
    () => env.SPRIGR.registerWebhookTenant(workspaceId, { path: '/acme/shared' }),
    'registerSharedTenant calls env.SPRIGR.registerWebhookTenant — publish to staging.',
  );
}

export default {
  showcase_webhook_contact: (args: WebhookArgs, env: ShowcaseEnv) => onContact(env, args),
  showcase_webhook_deal: (args: WebhookArgs, env: ShowcaseEnv) => onDeal(env, args),
  showcase_webhook_bookmarklet: (args: WebhookArgs, env: ShowcaseEnv) => onBookmarklet(env, args),
  showcase_webhook_shared: (args: WebhookArgs, env: ShowcaseEnv) => onShared(env, args),
};

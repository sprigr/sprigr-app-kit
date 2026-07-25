/**
 * Showcase - conversational channel handlers (Acme Chat).
 *
 * Three manifest channels[] tools wire a two-way messaging surface:
 *   - receive_tool  verifies the provider signature, decodes a raw inbound
 *                   event into ONE of: a url-verification challenge echo, a
 *                   normalized InboundMessage, or an ignore signal.
 *   - send_tool     encodes + sends a normalized OutboundMessage via the
 *                   provider API using the app's stored token.
 *   - identity_tool maps a provider user id to a stable sender identity.
 *
 * Signature verification + decode are local. Actually POSTing to the
 * provider (send) is a plain network call on the platform — stubbed here.
 * inbox.append (if you route channel messages into the shared inbox) is
 * staging-only.
 */

import { hmacSha256Hex, constantTimeEqual } from '@sprigr/apps-app-sdk';
import { getSetting } from '../lib/store';
import { stagingOnly } from '../lib/env';
import type { WebhookArgs } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

/** Normalized inbound message the platform delivers to the agent inbox. */
interface InboundMessage {
  kind: 'message';
  externalUserId: string;
  text: string;
  threadId?: string;
}
type ReceiveResult =
  | { challenge: string } // url-verification echo
  | { ignore: true; reason: string }
  | InboundMessage;

// ── receive_tool ────────────────────────────────────────────────────────────
export async function receive(env: ShowcaseEnv, args: WebhookArgs): Promise<ReceiveResult | HandlerResult> {
  const body = JSON.parse(args.body) as {
    type?: string;
    challenge?: string;
    event?: { user?: string; text?: string; thread_ts?: string; bot_id?: string };
  };

  // Provider URL-verification handshake — echo the challenge.
  if (body.type === 'url_verification' && body.challenge) {
    return { challenge: body.challenge };
  }

  // Verify signature (Acme Chat signs the raw body, hex).
  const provided = (args.headers ?? {})['x-acme-chat-signature'] ?? args.signature ?? '';
  const expected = await hmacSha256Hex(env.ACME_WEBHOOK_SECRET, args.body);
  if (!constantTimeEqual(provided, expected)) {
    return { ignore: true, reason: 'signature mismatch' };
  }

  // Ignore self-messages / retries.
  const ev = body.event;
  if (!ev || ev.bot_id || !ev.text || !ev.user) {
    return { ignore: true, reason: 'self-message or non-text event' };
  }
  return { kind: 'message', externalUserId: ev.user, text: ev.text, threadId: ev.thread_ts };
}

/** Normalized outbound message the agent asks the app to send. */
interface OutboundMessage {
  externalUserId?: string;
  channelId?: string;
  text: string;
  threadId?: string;
}

// ── send_tool ────────────────────────────────────────────────────────────────
export async function send(env: ShowcaseEnv, args: OutboundMessage): Promise<HandlerResult> {
  // Read the stored provider token (local D1).
  const token = await getSetting(env.DB, 'acme_chat_token');
  if (!token) return { ok: false, reason: 'Acme Chat not connected' };
  // On the platform this POSTs api.acme.example/chat.postMessage. Stubbed so
  // local dev returns the encoded envelope; a real send is just fetch().
  return {
    ok: true,
    result: { sent: true, to: args.externalUserId ?? args.channelId, text: args.text, thread: args.threadId },
  };
}

// ── identity_tool ────────────────────────────────────────────────────────────
export async function identity(env: ShowcaseEnv, args: { externalUserId: string }): Promise<HandlerResult> {
  // Map provider user id -> stable identity. Could env.SPRIGR.inbox.append
  // to thread the conversation; shown as the staging-only branch.
  const stable = `acme:${args.externalUserId}`;
  const maybeInbox = await stagingOnly(
    () =>
      env.SPRIGR.inbox.append({
        channel: 'acme_chat',
        messages: [
          {
            sourceId: args.externalUserId,
            sourceIndex: 0,
            direction: 'inbound',
            body: '(identity resolution touchpoint)',
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    'identity optionally threads via env.SPRIGR.inbox.append — publish to staging.',
  );
  return { ok: true, result: { identity: stable, inbox: maybeInbox } };
}

export default {
  showcase_channel_receive: (args: WebhookArgs, env: ShowcaseEnv) => receive(env, args),
  showcase_channel_send: (args: OutboundMessage, env: ShowcaseEnv) => send(env, args),
  showcase_channel_identity: (args: { externalUserId: string }, env: ShowcaseEnv) => identity(env, args),
};

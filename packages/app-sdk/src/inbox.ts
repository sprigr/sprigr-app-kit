/**
 * The inbox contract for mail and ticket apps (sprigr-team decision 0150).
 *
 * An app that writes into the Sprigr inbox does four things, all typed here:
 *
 *   1. Declares each channel it writes under `capabilities.inbox_channels` in
 *      its manifest (`InboxChannelDeclaration`). Append refuses undeclared
 *      channels, and replies cannot send without a declared send tool.
 *   2. Appends synced messages with `env.SPRIGR.inbox.append` (`SyncedMessage`,
 *      `InboxOwner` on every batch). `withSprigrInboxFallback` makes that work
 *      from an inline route too.
 *   3. Implements the declared send tool on the one `sprigr.inbox.send/v1`
 *      argument shape, through `defineInboxSendHandler`, which enforces the
 *      mailbox-owner rule so it cannot be forgotten.
 *   4. If it collects a credential on its own page (no OAuth bouncer),
 *      reports the connection with `connectComplete`, which forwards the
 *      platform-signed viewer token so the platform knows who connected.
 */

import { parseActor } from './actor';
import type { InboxOwner } from './actor';
import { installTokenPost, overlaySprigr, resolveInstallBridge, type WfpBridgeEnv } from './wfp-bridge';
import type { ToolResult } from './tool-wrappers';

// ─── Declaration ──────────────────────────────────────────────

export const INBOX_SEND_CONTRACT_V1 = 'sprigr.inbox.send/v1' as const;

export interface InboxSendSupports {
  bcc: boolean;
  html: boolean;
  recipients: boolean;
  importance: boolean;
  internal_note: boolean;
}

/** One entry of `capabilities.inbox_channels`. Validated at publish. */
export interface InboxChannelDeclaration {
  /** Must start with your slug in snake case plus `_` (`acme-mail` -> `acme_mail_...`). */
  channel: string;
  kind: 'email' | 'ticket';
  /** 1-40 printable characters, no `<` or `>`. */
  label: string;
  icon: 'mail' | 'ticket' | 'chat';
  send?: {
    tool: string;
    contract: typeof INBOX_SEND_CONTRACT_V1;
    returns_message_id: { send: boolean; reply: boolean };
    attachments: 'file_key' | 'inline' | 'none';
    supports: InboxSendSupports;
  };
  signature_family?: string;
  attachment_repair_tool?: string;
  /** https only, host in `permissions.network_domains`; placeholders
   *  `{source_thread_id}` and `{source_id}`. */
  deep_link_template?: string | null;
}

// ─── Append ───────────────────────────────────────────────────

export interface SyncedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Opaque to the platform; your `fetch_attachment` tool resolves it. It
   *  must identify the connection, because that dispatch carries no actor. */
  providerAttachmentId?: string;
  contentId?: string;
  inline?: boolean;
}

export interface SyncedMessage {
  /** Unique within the channel; the platform dedups on (channel, sourceId). */
  sourceId: string;
  sourceIndex: string;
  sourceThreadId?: string;
  /** RFC 5322 Message-ID (brackets optional). */
  rfcMessageId?: string;
  channel?: string;
  direction: 'inbound' | 'outbound' | 'internal';
  fromName?: string;
  fromEmail?: string;
  toRecipients?: Array<{ name: string; email: string }>;
  ccRecipients?: Array<{ name: string; email: string }>;
  subject?: string;
  /** Plain text. May be '' when `bodyHtml` carries the content. */
  body: string;
  bodyHtml?: string;
  /** ISO 8601. */
  timestamp: string;
  sourceIsRead?: boolean;
  tags?: string[];
  attachments?: SyncedAttachment[];
}

export interface InboxAppendRequest {
  channel?: string;
  /** At most 500 per call. */
  messages: SyncedMessage[];
  /** The MAILBOX owner (from your connection row), never the dispatch caller. */
  owner?: InboxOwner;
}

export interface InboxAppendResult {
  ok: boolean;
  threadsCreated: number;
  messagesLinked: number;
  threadIds: string[];
  contentlessSkipped?: number;
}

export interface InboxFoldersRequest {
  channel?: string;
  /** At most 200 per call. Folder names match manual Sprigr folders. */
  items: Array<{ sourceId: string; addFolders?: string[]; removeFolders?: string[] }>;
  owner?: InboxOwner;
}

export interface InboxFoldersResult {
  ok: boolean;
  filed: number;
  unfiled: number;
  skippedGuarded: number;
  unknownFolders: string[];
}

export interface SprigrInboxApi {
  append(req: InboxAppendRequest): Promise<InboxAppendResult>;
  folders?(req: InboxFoldersRequest): Promise<InboxFoldersResult>;
}

/**
 * Return an env whose `SPRIGR.inbox` works from any execution context.
 *
 * `env.SPRIGR` is injected only on the `/__sprigr/*` dispatch path. An inline
 * route (a provider push receiver, your settings page) gets the raw bindings,
 * so this wires the same contract over the install-token HTTP bridge. Append
 * and folders THROW on a non-2xx, so a caller never advances a sync cursor
 * past messages the platform did not accept. With no bridge bindings the env
 * comes back unchanged and `SPRIGR.inbox` stays undefined: fail closed.
 */
export function withSprigrInboxFallback<E extends WfpBridgeEnv & object>(env: E): E {
  const bridge = resolveInstallBridge(env);
  const existing = (env.SPRIGR ?? undefined) as { inbox?: SprigrInboxApi } & Record<string, unknown> | undefined;
  const folders = bridge
    ? async (req: InboxFoldersRequest) =>
      (await installTokenPost(bridge, '/internal/wfp/inbox/folders', req, { label: 'inbox folders' })) as unknown as InboxFoldersResult
    : undefined;
  if (existing?.inbox) {
    if (existing.inbox.folders || !folders) return env;
    const inbox = existing.inbox;
    return overlaySprigr(env, { ...existing, inbox: { append: inbox.append.bind(inbox), folders } });
  }
  if (!bridge) return env;
  const append = async (req: InboxAppendRequest): Promise<InboxAppendResult> => {
    const r = (await installTokenPost(bridge, '/internal/wfp/inbox/append', req, { label: 'inbox append' })) as Partial<InboxAppendResult>;
    return {
      ok: r.ok !== false,
      threadsCreated: r.threadsCreated ?? 0,
      messagesLinked: r.messagesLinked ?? 0,
      threadIds: Array.isArray(r.threadIds) ? r.threadIds : [],
      ...(typeof r.contentlessSkipped === 'number' ? { contentlessSkipped: r.contentlessSkipped } : {}),
    };
  };
  return overlaySprigr(env, { ...(existing ?? {}), inbox: { append, folders } });
}

// ─── Send ─────────────────────────────────────────────────────

export interface InboxAddress {
  email: string;
  name?: string;
}

/** What the platform sends your declared send tool. snake_case. */
export interface InboxSendV1Args {
  contract: typeof INBOX_SEND_CONTRACT_V1;
  from_email?: string;
  to?: InboxAddress[];
  cc?: InboxAddress[];
  bcc?: InboxAddress[];
  subject?: string;
  body_text: string;
  body_html?: string;
  attachments?:
    | Array<{ file_key: string; filename: string; content_type: string }>
    | Array<{ filename: string; mime_type?: string; base64_body: string }>;
  /** `source_id` / `source_thread_id` are YOUR stored ids, present only when
   *  your install received the mail being answered. */
  reply?: { source_id?: string; source_thread_id?: string; rfc_message_id?: string; references: string[] };
  internal_note?: boolean;
  author_email?: string;
  importance?: 'high' | 'low';
  idempotency_key?: string;
}

/** What your send tool returns. `message_id` must equal the `sourceId` your
 *  sync will write for the sent copy, so the Sent echo dedups. */
export interface InboxSendV1Result {
  message_id?: string;
  internet_message_id?: string;
  thread_id?: string;
}

/** Your connection record, as far as the owner check needs it. */
export interface InboxSendConnection {
  /** `u:<platformUserId>` or `a:<agentId>`: the key the connection is filed under. */
  actorKey: string;
}

export interface InboxSendHandlerImpl<E, C extends InboxSendConnection> {
  /** The connection that owns one of YOUR stored source ids, or null when the
   *  id is not yours. Parse your own id format here. */
  connectionForSourceId(env: E, sourceId: string): Promise<C | null>;
  /** The connection this actor key sends a NEW mail from. When `fromEmail` is
   *  set, return only a connection that may send as that address, else null. */
  connectionForActor(env: E, actorKey: string, fromEmail: string | undefined): Promise<C | null>;
  send(env: E, connection: C, args: InboxSendV1Args): Promise<InboxSendV1Result>;
}

export class InboxSendRefusal extends Error {
  constructor(readonly code: 'no_caller_identity' | 'not_your_mailbox' | 'not_connected' | 'invalid_args', message: string) {
    super(message);
    this.name = 'InboxSendRefusal';
  }
}

/**
 * Build the handler for your declared `sprigr.inbox.send/v1` tool.
 *
 * THE MAILBOX-OWNER RULE, enforced here so no app can omit it: replies are
 * dispatched under the WRITER's actor, and anyone who can read a thread can
 * press Reply. So the connection you send from must be filed under one of the
 * writer's own keys (`u:<platformUserId>`, `a:<agentId>`). A reply whose
 * source belongs to someone else's connection is REFUSED, never re-routed to
 * the writer's own mailbox and never sent from the owner's: either would
 * deliver mail the writer is not entitled to send.
 */
export function defineInboxSendHandler<E, C extends InboxSendConnection>(
  impl: InboxSendHandlerImpl<E, C>,
): (args: Record<string, unknown>, env: E) => Promise<ToolResult<InboxSendV1Result>> {
  return async (rawArgs, env) => {
    try {
      const actor = parseActor(rawArgs);
      const keys = [
        ...(actor?.platformUserId ? [`u:${actor.platformUserId}`] : []),
        ...(actor?.agentId ? [`a:${actor.agentId}`] : []),
      ];
      if (keys.length === 0) {
        throw new InboxSendRefusal('no_caller_identity', 'The platform stamped no sender identity on this send.');
      }
      const args = rawArgs as unknown as InboxSendV1Args;
      if (args.contract !== INBOX_SEND_CONTRACT_V1 || typeof args.body_text !== 'string') {
        throw new InboxSendRefusal('invalid_args', `Expected ${INBOX_SEND_CONTRACT_V1} arguments.`);
      }
      let connection: C | null = null;
      const sourceId = args.reply?.source_id;
      if (sourceId) {
        const owner = await impl.connectionForSourceId(env, sourceId);
        if (owner) {
          if (!keys.includes(owner.actorKey)) {
            throw new InboxSendRefusal(
              'not_your_mailbox',
              'This conversation arrived in a mailbox that belongs to someone else, so you cannot reply from it.',
            );
          }
          if (args.from_email) {
            const asFrom = await impl.connectionForActor(env, owner.actorKey, args.from_email);
            if (!asFrom || asFrom.actorKey !== owner.actorKey) {
              throw new InboxSendRefusal('not_your_mailbox', `This mailbox cannot send as ${args.from_email}.`);
            }
          }
          connection = owner;
        }
      }
      if (!connection) {
        for (const key of keys) {
          connection = await impl.connectionForActor(env, key, args.from_email);
          if (connection) break;
        }
      }
      if (!connection) {
        throw new InboxSendRefusal(
          'not_connected',
          args.from_email
            ? `You have no connection that can send as ${args.from_email}.`
            : 'You have not connected a mailbox with this app.',
        );
      }
      if (!keys.includes(connection.actorKey)) {
        // Defence in depth against a connectionForActor that returns a row
        // filed under someone else.
        throw new InboxSendRefusal('not_your_mailbox', 'Resolved connection does not belong to the sender.');
      }
      return { ok: true, result: await impl.send(env, connection, args) };
    } catch (err) {
      if (err instanceof InboxSendRefusal || (err instanceof Error && err.name === 'InboxSendRefusal')) {
        const code = (err as InboxSendRefusal).code;
        return { ok: false, error: `${code}: ${err.message}`, status: code === 'invalid_args' ? 400 : 412 };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ─── Connect ──────────────────────────────────────────────────

export interface ConnectCompleteRequest {
  /** The raw `X-Sprigr-Viewer` header of the PAGE request that submitted the
   *  credential. The platform takes the user only from this. */
  viewer_token: string;
  bind?: { kind: 'user' } | { kind: 'agent'; agent_id: string };
  account: { email: string; name?: string };
  identities?: Array<{ email: string; name?: string }>;
}

export interface ConnectCompleteResult {
  ok: boolean;
  /** File your connection under this key. */
  actor_key: string;
  identities: { inserted: number; updated: number; deleted: number };
  /** The same address already connected through another app in the company. */
  existing_mailboxes: Array<{ app_slug: string; email: string; account_email: string }>;
}

/**
 * Report a mailbox connected on your own page (token paste, app password).
 * Call it from the inline route that handled the page's POST, passing that
 * request's `X-Sprigr-Viewer` header. Throws on a non-2xx with `.status` and
 * `.error` (`viewer_unverified`, `viewer_not_a_member`, `agent_bind_refused`,
 * `agent_bind_requires_admin`, ...).
 */
export async function connectComplete(env: WfpBridgeEnv, req: ConnectCompleteRequest): Promise<ConnectCompleteResult> {
  const bridge = resolveInstallBridge(env);
  if (!bridge) throw new Error('connectComplete: SPRIGR_PLATFORM_BASE / SPRIGR_INSTALL_TOKEN are not bound');
  return (await installTokenPost(bridge, '/internal/wfp/connect/complete', req, { label: 'connect complete' })) as unknown as ConnectCompleteResult;
}

/** Retire a connection's From-picker identities (install token only, so a
 *  background sync can call it when a credential dies). */
export async function connectDisconnect(
  env: WfpBridgeEnv,
  req: { actor_key: string; account_email?: string },
): Promise<{ ok: boolean; deleted: number }> {
  const bridge = resolveInstallBridge(env);
  if (!bridge) throw new Error('connectDisconnect: SPRIGR_PLATFORM_BASE / SPRIGR_INSTALL_TOKEN are not bound');
  return (await installTokenPost(bridge, '/internal/wfp/connect/disconnect', req, { label: 'connect disconnect' })) as unknown as { ok: boolean; deleted: number };
}

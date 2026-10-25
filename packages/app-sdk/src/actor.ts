/**
 * Caller identity stamped by the platform on agent-initiated WFP dispatches.
 *
 * Platform-controlled headers carry the actor on every dispatch:
 *
 *   x-sprigr-actor-agent-id           — calling agent's id (always present
 *                                       when an agent is the caller)
 *   x-sprigr-actor-platform-user-id   — OIDC sub of the user the agent is
 *                                       bound to (absent for unbound agents)
 *   x-sprigr-actor-role               — bound user's display role at the
 *                                       company; informational only
 *   x-sprigr-actor-surface            — where the turn came from (portal,
 *                                       website, external_channel, ...)
 *   x-sprigr-actor-person-id          — the person the call is made for
 *   x-sprigr-actor-person-source      — live | schedule_creator | workflow_saver
 *
 * The sprigr-wrapper parses these and surfaces an `Actor` via `args.actor`
 * to handler code. Apps that need per-user scoping (per-actor OAuth tokens,
 * per-user audit) must read identity from `args.actor` only — body fields
 * are agent-supplied and spoofable.
 *
 * Wired in the platform dispatch wrapper.
 */
export interface Actor {
  /** Calling agent's id. Always present when dispatch is agent-initiated. */
  agentId?: string;
  /** OIDC sub of the user the agent is bound to. Apps key per-user state on
   *  this when set; falls back to agentId when the agent has no bound user. */
  platformUserId?: string;
  /** Bound user's display role at the company. Display + audit only — apps
   *  must not gate authorisation on this without server-side verification. */
  role?: string;
  /** Where the turn came from (sprigr-team decision 0305). `portal` is staff;
   *  `website` and `external_channel` are the public. Treat a missing value as
   *  public: an older platform, an app built before this field, or a dispatch
   *  with no actor sends none. */
  surface?: CallerSurface;
  /** Platform user id of the person the call is made for. Absent for a
   *  website visitor, a phone number, or a run with no person. Gate a
   *  person's own records on this, never on `platformUserId`, which is the
   *  agent's bound user on every turn, including a visitor's. */
  personId?: string;
  /** How `personId` is the person: `live` (chatting now), `schedule_creator`
   *  (created the schedule that fired), `workflow_saver` (last saved the
   *  workflow). Present only with `personId`. */
  personSource?: PersonSource;
}

/**
 * The caller surfaces the platform stamps (sprigr-team decision 0305).
 *
 * TRUST LEVEL of `surface`, `personId` and `personSource`: transport-trusted,
 * the same as `platformUserId`. The platform sets them on the dispatch, strips
 * any copy from caller input (request headers and the body's `actor`), and the
 * wrapper rebuilds `args.actor` from its own headers on every call. Only the
 * platform can reach an install's script, which is what makes that enough to
 * decide what a handler returns. They are NOT signed for the app: an app
 * cannot verify them, and must not forward them as proof to anything else.
 */
export const CALLER_SURFACES = [
  'portal', 'website', 'external_channel', 'mcp', 'schedule', 'workflow', 'delegated', 'webhook', 'system',
] as const;
export type CallerSurface = (typeof CALLER_SURFACES)[number];

export const PERSON_SOURCES = ['live', 'schedule_creator', 'workflow_saver'] as const;
export type PersonSource = (typeof PERSON_SOURCES)[number];

/**
 * Parse the platform-stamped actor headers off an incoming request. Returns
 * undefined when no actor headers are present (webhook receivers, schedule
 * firers, event consumers — no per-call user). Returns a partial actor when
 * at least one header is set.
 *
 * Apps that require caller identity must treat `undefined` as a hard fail
 * (return 412 with a clear hint) rather than fall back to install-wide
 * tokens — see plan risk R13.
 *
 *   const actor = parseActor(args);
 *   if (!actor?.platformUserId && !actor?.agentId) {
 *     return jsonError(412, 'no_caller_identity');
 *   }
 *
 * Usage: pass the wrapper's `args` object directly. The wrapper writes
 * `args.actor` from the headers; this helper just narrows the type and
 * normalises the shape.
 */
export function parseActor(args: unknown): Actor | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = (args as { actor?: unknown }).actor;
  if (!a || typeof a !== 'object') return undefined;
  const obj = a as Record<string, unknown>;
  const out: Actor = {};
  if (typeof obj.agentId === 'string' && obj.agentId.length > 0) out.agentId = obj.agentId;
  if (typeof obj.platformUserId === 'string' && obj.platformUserId.length > 0) {
    out.platformUserId = obj.platformUserId;
  }
  if (typeof obj.role === 'string' && obj.role.length > 0) out.role = obj.role;
  if (typeof obj.surface === 'string' && (CALLER_SURFACES as readonly string[]).includes(obj.surface)) {
    out.surface = obj.surface as CallerSurface;
  }
  if (typeof obj.personId === 'string' && obj.personId.length > 0) {
    out.personId = obj.personId;
    if (typeof obj.personSource === 'string' && (PERSON_SOURCES as readonly string[]).includes(obj.personSource)) {
      out.personSource = obj.personSource as PersonSource;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Stable key for per-actor state in per-install D1. Prefers platformUserId
 * (durable across agent rebinds) and falls back to agentId for unbound
 * agents (orchestrator, system).
 *
 *   const tokens = await db
 *     .prepare('SELECT * FROM simpro_actor_tokens WHERE actor_key = ?')
 *     .bind(actorKey(actor))
 *     .first();
 *
 * Returns null when the actor has neither field set — callers should
 * treat that as "no caller identity" and fail closed.
 */
export function actorKey(actor: Actor | undefined): string | null {
  if (!actor) return null;
  if (actor.platformUserId) return `u:${actor.platformUserId}`;
  if (actor.agentId) return `a:${actor.agentId}`;
  return null;
}

/**
 * Mailbox-owner attribution for one `env.SPRIGR.inbox.append` /
 * `env.SPRIGR.inbox.folders` batch.
 *
 * Exactly ONE of the two fields must be set:
 *
 *   - `platformUserId` — OIDC sub of the user whose mailbox the batch was
 *     synced from (a personal mailbox connection).
 *   - `agentId` — agent id for an agent-keyed connection (a shared /
 *     departmental mailbox connected through a shared agent rather than a
 *     person).
 *
 * Why this exists: a mail app install is shared by the whole company, and
 * several users can each connect their own mailbox to it. The platform files
 * every appended message under the ONE integration behind the install, so
 * without attribution it cannot tell whose mailbox a batch came from and has
 * historically granted thread visibility to every connected user. Passing
 * `owner` pins each synced thread's visibility to exactly the mailbox owner:
 * user connections stay private to that user, agent-keyed connections stay
 * visible to that agent's audience.
 *
 * This is the OWNER OF THE MAILBOX (the connection identity the app keyed
 * the sync on), NOT the dispatch caller — a scheduled poll has no caller at
 * all yet must still attribute every batch. Populate it from the per-actor
 * connection row the sync loop is iterating, e.g.:
 *
 *   const owner = row.sprigr_user_id
 *     ? { platformUserId: row.sprigr_user_id }
 *     : { agentId: row.sprigr_agent_id };
 *   await env.SPRIGR.inbox.append({ channel, messages, owner });
 *
 * Mail apps must send it on EVERY append/folders call (sync poll, push
 * delivery, backfill, folder reports). Batches without it fall back to the
 * platform's legacy integration-level resolution, which on a multi-user
 * install pins nobody (fail closed) rather than everyone.
 *
 * Hosts older than the attribution surface ignore the field entirely, so
 * sending it is always safe.
 */
export interface InboxOwner {
  /** OIDC sub (platform user id) of the mailbox's owner. */
  platformUserId?: string;
  /** Agent id for an agent-keyed (shared-mailbox) connection. */
  agentId?: string;
}

/**
 * Inverse of `actorKey`: turn a stored `u:<platformUserId>` / `a:<agentId>`
 * key back into an `InboxOwner`. For apps that persist the connection
 * identity as an actor-key string and need to attribute inbox batches from
 * it. Returns null for null/empty/unrecognised input — callers should treat
 * that as "owner unknown" and omit the field rather than guess.
 */
export function ownerFromActorKey(key: string | null | undefined): InboxOwner | null {
  if (!key) return null;
  if (key.startsWith('u:') && key.length > 2) return { platformUserId: key.slice(2) };
  if (key.startsWith('a:') && key.length > 2) return { agentId: key.slice(2) };
  return null;
}

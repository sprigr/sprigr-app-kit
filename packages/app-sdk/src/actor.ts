/**
 * Caller identity stamped by the platform on agent-initiated WFP dispatches.
 *
 * Three platform-controlled headers carry the actor on every dispatch:
 *
 *   x-sprigr-actor-agent-id           — calling agent's id (always present
 *                                       when an agent is the caller)
 *   x-sprigr-actor-platform-user-id   — OIDC sub of the user the agent is
 *                                       bound to (absent for unbound agents)
 *   x-sprigr-actor-role               — bound user's display role at the
 *                                       company; informational only
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
}

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

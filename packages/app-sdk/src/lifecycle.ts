/**
 * The `on_actor_retired` lifecycle hook (sprigr-team decision 0154,
 * sprigr/sprigr-team#10109).
 *
 * A per-actor app keys a person's connection, tokens and data on the key
 * `actorKey()` derives: `u:<platformUserId>`, else `a:<agentId>`. When that
 * identity goes away (a member is removed, an agent is deleted, a companion's
 * bound user id is corrected, or an operator retires an orphan), the platform
 * POSTs `/__sprigr/tool/on_actor_retired` to every install that declares a
 * tool of that name. The app should run its own self-disconnect
 * revoke-and-purge for that key and nothing else.
 *
 *   // src/handlers/index.ts
 *   import { actorRetiredHook } from '@sprigr/apps-app-sdk';
 *   export default {
 *     on_actor_retired: actorRetiredHook<MyEnv>(async (env, retired) => {
 *       await revokeAndPurge(env, retired.actor, { cutoff: retired.requestedAt, ownerRef: retired.storageOwnerRef });
 *       return { done: true };
 *     }),
 *   };
 *
 * Manifest: declare the tool with `"internal": true`. The platform keeps it
 * off every agent tool list and refuses it on the app-bridge invoke route
 * either way, because its body names whose grant to revoke.
 *
 * Contract:
 *   - The dispatch carries NO actor. `actorRetiredHook` throws when `args.actor`
 *     is present (a call that did not come from this hook), and when the body
 *     is malformed. A throw reaches the platform as a 500, which it retries
 *     and finally logs, so a contract mismatch is loud rather than a silent
 *     "done".
 *   - Return `{ done: true }` when finished, or when the rest is durably
 *     queued by the app itself. Return `{ done: false, remaining }` to be
 *     called again later (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h; 8
 *     deliveries in all). A thrown error is retried the same way.
 *   - Idempotent: a second delivery for a key already purged must return
 *     `{ done: true }`.
 *   - `successorKey` is audit only. Never move the grant or the data to it.
 *   - Delete only what existed by `requestedAt`.
 *   - `storageOwnerRef` is the `owner_ref` a no-actor maintenance
 *     `env.SPRIGR.files.list` reports for this person's per-user stored files;
 *     pass it to a no-actor `env.SPRIGR.files.delete(key, { owner_ref })`.
 *     Only the platform can derive it.
 */

import { actorKey, type Actor } from './actor';

/** The manifest tool name the platform dispatches. */
export const ACTOR_RETIRED_HOOK_TOOL = 'on_actor_retired';

/** Why the key is being retired. */
export type ActorRetireReason = 'member_removed' | 'agent_deleted' | 'user_id_superseded' | 'admin_removed';

export const ACTOR_RETIRE_REASONS: readonly ActorRetireReason[] = [
  'member_removed',
  'agent_deleted',
  'user_id_superseded',
  'admin_removed',
];

/** The wire body, exactly as the platform POSTs it (snake_case). */
export interface ActorRetiredHookBody {
  trigger: 'actor_retired';
  install_id: string;
  company_id: string;
  /** `u:<platform_user_id>` or `a:<agent_id>`. */
  actor_key: string;
  platform_user_id?: string;
  agent_id?: string;
  reason: ActorRetireReason;
  /** Audit only. */
  successor_key?: string;
  /** 32 hex chars: the per-user storage owner (`owner_ref`). */
  storage_owner_ref: string;
  requested_by?: string;
  /** ISO time; purge only what existed by then. */
  requested_at: string;
  /** 1 on the first delivery. */
  attempt: number;
}

/** The parsed body a handler receives. */
export interface ActorRetired {
  installId: string;
  companyId: string;
  /** The app-side key, equal to `actorKey(actor)`. */
  actorKey: string;
  /** The retired identity, shaped like a stamped actor so existing per-actor
   *  helpers (token stores, walk keys) can be called with it. */
  actor: Actor;
  reason: ActorRetireReason;
  successorKey?: string;
  storageOwnerRef: string;
  requestedBy?: string;
  /** Epoch ms of `requested_at`. */
  requestedAt: number;
  attempt: number;
}

/** What the handler returns. */
export interface ActorRetiredResult {
  done: boolean;
  /** Anything that says what is left, for the platform's log. */
  remaining?: unknown;
  [extra: string]: unknown;
}

const OWNER_REF_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^([ua]):([A-Za-z0-9_\-.:@]{1,200})$/;

/**
 * Parse and check the hook body. Throws an Error naming the first problem;
 * never returns a partial value.
 */
export function parseActorRetiredArgs(args: unknown): ActorRetired {
  if (!args || typeof args !== 'object') throw new Error('on_actor_retired: body is not an object');
  const b = args as Record<string, unknown>;
  if (b.actor !== undefined && b.actor !== null) {
    throw new Error('on_actor_retired: refused, the call carries an actor; only the platform hook may call this');
  }
  if (b.trigger !== 'actor_retired') throw new Error(`on_actor_retired: trigger must be actor_retired, got ${String(b.trigger)}`);
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== 'string' || v === '') throw new Error(`on_actor_retired: ${k} is required`);
    return v;
  };
  const installId = str('install_id');
  const companyId = str('company_id');
  const key = str('actor_key');
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`on_actor_retired: actor_key must be u:<id> or a:<id>, got ${key.slice(0, 80)}`);
  const actor: Actor = m[1] === 'u' ? { platformUserId: m[2]! } : { agentId: m[2]! };
  if (m[1] === 'u' && b.platform_user_id !== undefined && b.platform_user_id !== m[2]) {
    throw new Error('on_actor_retired: platform_user_id does not match actor_key');
  }
  if (m[1] === 'a' && b.agent_id !== undefined && b.agent_id !== m[2]) {
    throw new Error('on_actor_retired: agent_id does not match actor_key');
  }
  if (actorKey(actor) !== key) throw new Error('on_actor_retired: actor_key does not round-trip');
  const reason = b.reason;
  if (typeof reason !== 'string' || !(ACTOR_RETIRE_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`on_actor_retired: unknown reason ${String(reason)}`);
  }
  const storageOwnerRef = str('storage_owner_ref');
  if (!OWNER_REF_RE.test(storageOwnerRef)) throw new Error('on_actor_retired: storage_owner_ref must be 32 lowercase hex characters');
  const requestedAt = Date.parse(str('requested_at'));
  if (!Number.isFinite(requestedAt)) throw new Error('on_actor_retired: requested_at is not a date');
  const attempt = typeof b.attempt === 'number' && b.attempt >= 1 ? b.attempt : 1;
  return {
    installId,
    companyId,
    actorKey: key,
    actor,
    reason: reason as ActorRetireReason,
    ...(typeof b.successor_key === 'string' && b.successor_key ? { successorKey: b.successor_key } : {}),
    storageOwnerRef,
    ...(typeof b.requested_by === 'string' && b.requested_by ? { requestedBy: b.requested_by } : {}),
    requestedAt,
    attempt,
  };
}

/**
 * Wrap an `on_actor_retired` handler in the wrapper's `(args, env)` calling
 * convention. Unlike `tool()` it does NOT turn a throw into `{ ok: false }`:
 * the platform reads the returned `done`, and a swallowed error would read as
 * finished. A throw becomes a 500 the platform retries.
 */
export function actorRetiredHook<Env>(
  fn: (env: Env, retired: ActorRetired) => Promise<ActorRetiredResult>,
): (args: unknown, env: Env) => Promise<ActorRetiredResult> {
  return async (args, env) => {
    const retired = parseActorRetiredArgs(args);
    const result = await fn(env, retired);
    if (!result || typeof result.done !== 'boolean') {
      throw new Error('on_actor_retired: the handler must return { done: boolean }');
    }
    return result;
  };
}

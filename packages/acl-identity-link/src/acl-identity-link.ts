/**
 * Doc-ACL identity links (sprigr-team decision 0118).
 *
 * An app that indexes a connected account's files into its `-acl-files` index
 * stamps each row with `user:<connected_email>`, the provider account the
 * connection belongs to. The platform identifies a searcher by their Sprigr
 * login, so when that login is a different address the owner sees none of
 * their own files. Telling the platform "this connection's owner is this
 * provider account" makes the owner's search key include that principal, on
 * THIS install's index only.
 *
 * `linkIdentity` is idempotent on the platform (it writes only on a miss), and
 * each indexing run calls it, so existing connections backfill on their next
 * run. A per-isolate memo keeps a hot isolate from re-asking every tick.
 */
import type { AclIdentityEnv, AclOwner, AclActor, AclIdentityLinkResult } from './types';

/** The platform owner for a connection's actor: the human if there is one. */
export function aclOwnerForActor(actor: AclActor): AclOwner | null {
  if (actor.platformUserId) return { kind: 'user', id: actor.platformUserId };
  if (actor.agentId) return { kind: 'agent', id: actor.agentId };
  return null;
}

const linkedThisIsolate = new Set<string>();
const ownerNotFoundThisIsolate = new Set<string>();

/** Test hook: forget what this isolate already linked or was refused. */
export function resetAclIdentityLinkMemoForTests(): void {
  linkedThisIsolate.clear();
  ownerNotFoundThisIsolate.clear();
}

// `env.SPRIGR.acl.linkIdentity` failed: 404 owner_not_found. Matches the
// bridge's thrown message when the build-runner doesn't yet carry `err.code`
// (sprigr-team#9075 step 0). Prefer `err.code` when it's present.
const OWNER_NOT_FOUND_MESSAGE = /\b404 owner_not_found\b/;

function isOwnerNotFound(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'owner_not_found') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return OWNER_NOT_FOUND_MESSAGE.test(message);
}

/**
 * Record that `actor`'s connection belongs to `email`. Best-effort in the
 * sense that it never throws: on failure it logs and returns a result the
 * caller can act on (or ignore, unchanged from before). A no-op when the
 * platform bridge predates `env.SPRIGR.acl` (an older build-runner), or when
 * there's nothing to link, which reports `{ ok: false, reason: 'unavailable' }`.
 *
 * A platform refusal of `owner_not_found` is terminal for the current owner
 * (sprigr-team decision 0118: an unknown or inactive owner never collects a
 * link) — repeating the exact same call every tick wastes a round trip and
 * spams the warn log, so a per-isolate negative memo skips it until the next
 * cold start.
 */
export async function recordAclIdentityLink(
  env: AclIdentityEnv,
  actor: AclActor,
  email: string | null | undefined,
): Promise<AclIdentityLinkResult> {
  const acl = env.SPRIGR?.acl;
  const owner = aclOwnerForActor(actor);
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!acl?.linkIdentity || !owner || !address) return { ok: false, reason: 'unavailable' };
  const memoKey = `${owner.kind}:${owner.id}|${address}`;
  if (linkedThisIsolate.has(memoKey)) return { ok: true };
  if (ownerNotFoundThisIsolate.has(memoKey)) return { ok: false, reason: 'owner_not_found' };
  try {
    await acl.linkIdentity(owner, address);
    linkedThisIsolate.add(memoKey);
    return { ok: true };
  } catch (err) {
    console.warn(
      `[acl-identity-link] linkIdentity failed for ${owner.kind} ${owner.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    if (isOwnerNotFound(err)) {
      ownerNotFoundThisIsolate.add(memoKey);
      return { ok: false, reason: 'owner_not_found' };
    }
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Drop the link(s) when a connection goes away. With `email`, only that
 * account; without, every account the owner linked on this install.
 */
export async function removeAclIdentityLink(
  env: AclIdentityEnv,
  actor: AclActor,
  email?: string | null,
): Promise<void> {
  const acl = env.SPRIGR?.acl;
  const owner = aclOwnerForActor(actor);
  if (!acl?.unlinkIdentity || !owner) return;
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  for (const key of [...linkedThisIsolate]) {
    if (key.startsWith(`${owner.kind}:${owner.id}|`) && (!address || key.endsWith(`|${address}`))) {
      linkedThisIsolate.delete(key);
    }
  }
  for (const key of [...ownerNotFoundThisIsolate]) {
    if (key.startsWith(`${owner.kind}:${owner.id}|`) && (!address || key.endsWith(`|${address}`))) {
      ownerNotFoundThisIsolate.delete(key);
    }
  }
  try {
    await acl.unlinkIdentity(owner, address || undefined);
  } catch (err) {
    console.warn(
      `[acl-identity-link] unlinkIdentity failed for ${owner.kind} ${owner.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

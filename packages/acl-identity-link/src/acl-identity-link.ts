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
import type { AclIdentityEnv, AclOwner, AclActor } from './types';

/** The platform owner for a connection's actor: the human if there is one. */
export function aclOwnerForActor(actor: AclActor): AclOwner | null {
  if (actor.platformUserId) return { kind: 'user', id: actor.platformUserId };
  if (actor.agentId) return { kind: 'agent', id: actor.agentId };
  return null;
}

const linkedThisIsolate = new Set<string>();

/** Test hook: forget what this isolate already linked. */
export function resetAclIdentityLinkMemoForTests(): void {
  linkedThisIsolate.clear();
}

/**
 * Record that `actor`'s connection belongs to `email`. Best-effort: a failure
 * only means the owner keeps seeing public files until the next run, so it
 * logs and never fails the indexing run. A no-op when the platform bridge
 * predates `env.SPRIGR.acl` (an older build-runner).
 */
export async function recordAclIdentityLink(
  env: AclIdentityEnv,
  actor: AclActor,
  email: string | null | undefined,
): Promise<void> {
  const acl = env.SPRIGR?.acl;
  const owner = aclOwnerForActor(actor);
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!acl?.linkIdentity || !owner || !address) return;
  const memoKey = `${owner.kind}:${owner.id}|${address}`;
  if (linkedThisIsolate.has(memoKey)) return;
  try {
    await acl.linkIdentity(owner, address);
    linkedThisIsolate.add(memoKey);
  } catch (err) {
    console.warn(
      `[acl-identity-link] linkIdentity failed for ${owner.kind} ${owner.id}:`,
      err instanceof Error ? err.message : String(err),
    );
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
  try {
    await acl.unlinkIdentity(owner, address || undefined);
  } catch (err) {
    console.warn(
      `[acl-identity-link] unlinkIdentity failed for ${owner.kind} ${owner.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

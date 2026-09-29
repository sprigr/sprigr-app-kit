/**
 * Structural types, so this package needs no runtime dependency. An app's own
 * env type and `@sprigr/apps-app-sdk`'s `Actor` are both assignable to them.
 */

/** Who a connection belongs to on the platform. */
export type AclOwner = { kind: 'user' | 'agent'; id: string };

/** The caller identity the platform stamps on a dispatch (app-sdk `Actor`). */
export interface AclActor {
  agentId?: string;
  platformUserId?: string;
}

/** `env.SPRIGR.acl`: absent on a build-runner that predates decision 0118. */
export interface AclIdentityBridge {
  linkIdentity?(owner: AclOwner, email: string): Promise<unknown>;
  unlinkIdentity?(owner: AclOwner, email?: string): Promise<unknown>;
}

/** The slice of an app's env this package reads. */
export interface AclIdentityEnv {
  SPRIGR?: { acl?: AclIdentityBridge };
}

/**
 * Outcome of `recordAclIdentityLink`. Never thrown — a caller that wants to
 * react to a terminal refusal (e.g. back off retrying) reads this; a caller
 * that doesn't care can keep ignoring the return value, as before.
 */
export type AclIdentityLinkResult =
  | { ok: true }
  | { ok: false; reason: 'owner_not_found' | 'failed' | 'unavailable' };

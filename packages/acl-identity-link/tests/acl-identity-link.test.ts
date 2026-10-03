/**
 * Doc-ACL identity links: the app tells the platform which provider account
 * each connection belongs to, so an owner whose Sprigr login differs from that
 * address can see their own indexed files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  aclOwnerForActor,
  recordAclIdentityLink,
  removeAclIdentityLink,
  resetAclIdentityLinkMemoForTests,
  type AclIdentityBridge,
  type AclIdentityEnv,
} from '../src/index';

function envWith(acl?: AclIdentityBridge): AclIdentityEnv {
  return { SPRIGR: acl ? { acl } : {} };
}

beforeEach(() => resetAclIdentityLinkMemoForTests());

describe('aclOwnerForActor', () => {
  it('prefers the human, falls back to the agent', () => {
    expect(aclOwnerForActor({ platformUserId: 'plat_1', agentId: 'agt_1' })).toEqual({ kind: 'user', id: 'plat_1' });
    expect(aclOwnerForActor({ agentId: 'agt_1' })).toEqual({ kind: 'agent', id: 'agt_1' });
    expect(aclOwnerForActor({})).toBeNull();
  });
});

describe('recordAclIdentityLink', () => {
  it('links the connected email for the owner, normalised, once per isolate', async () => {
    const linkIdentity = vi.fn(async () => ({ ok: true }));
    const env = envWith({ linkIdentity });
    await expect(recordAclIdentityLink(env, { platformUserId: 'plat_1' }, ' Ops@Example.com ')).resolves.toEqual({ ok: true });
    await expect(recordAclIdentityLink(env, { platformUserId: 'plat_1' }, 'ops@example.com')).resolves.toEqual({ ok: true });
    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(linkIdentity).toHaveBeenCalledWith({ kind: 'user', id: 'plat_1' }, 'ops@example.com');
  });

  it('retries on the next run after a generic failure, and never throws', async () => {
    const linkIdentity = vi.fn(async () => { throw new Error('503'); });
    const env = envWith({ linkIdentity });
    await expect(recordAclIdentityLink(env, { agentId: 'agt_1' }, 'bot@example.com')).resolves.toEqual({ ok: false, reason: 'failed' });
    await recordAclIdentityLink(env, { agentId: 'agt_1' }, 'bot@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(2);
  });

  it('is a no-op on an older bridge, with no email, or with no actor', async () => {
    await expect(recordAclIdentityLink(envWith(), { platformUserId: 'p' }, 'a@example.com')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(recordAclIdentityLink({}, { platformUserId: 'p' }, 'a@example.com')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    const linkIdentity = vi.fn(async () => ({}));
    await recordAclIdentityLink(envWith({ linkIdentity }), { platformUserId: 'p' }, null);
    await recordAclIdentityLink(envWith({ linkIdentity }), { platformUserId: 'p' }, '   ');
    await recordAclIdentityLink(envWith({ linkIdentity }), {}, 'a@example.com');
    expect(linkIdentity).not.toHaveBeenCalled();
  });

  it('detects owner_not_found via err.code and memoizes the refusal for the isolate', async () => {
    const linkIdentity = vi.fn(async () => {
      const err = new Error('env.SPRIGR.acl.linkIdentity failed: 404 owner_not_found');
      (err as Error & { code?: string; status?: number }).code = 'owner_not_found';
      (err as Error & { code?: string; status?: number }).status = 404;
      throw err;
    });
    const env = envWith({ linkIdentity });
    await expect(recordAclIdentityLink(env, { platformUserId: 'ghost' }, 'a@example.com')).resolves.toEqual({
      ok: false,
      reason: 'owner_not_found',
    });
    // Negative memo: the second call on the same isolate never re-asks the platform.
    await expect(recordAclIdentityLink(env, { platformUserId: 'ghost' }, 'a@example.com')).resolves.toEqual({
      ok: false,
      reason: 'owner_not_found',
    });
    expect(linkIdentity).toHaveBeenCalledTimes(1);
  });

  it('detects owner_not_found via the message fallback when err.code is absent (older build-runner)', async () => {
    const linkIdentity = vi.fn(async () => {
      throw new Error('env.SPRIGR.acl.linkIdentity failed: 404 owner_not_found');
    });
    const env = envWith({ linkIdentity });
    await expect(recordAclIdentityLink(env, { platformUserId: 'ghost' }, 'a@example.com')).resolves.toEqual({
      ok: false,
      reason: 'owner_not_found',
    });
    await recordAclIdentityLink(env, { platformUserId: 'ghost' }, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unrelated 404 or a plain string error as owner_not_found', async () => {
    const linkIdentity = vi.fn(async () => { throw new Error('env.SPRIGR.acl.linkIdentity failed: 404 not_found'); });
    const env = envWith({ linkIdentity });
    await expect(recordAclIdentityLink(env, { platformUserId: 'p' }, 'a@example.com')).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    // A generic failure is NOT negatively memoized: it retries every call.
    await recordAclIdentityLink(env, { platformUserId: 'p' }, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('removeAclIdentityLink', () => {
  it('unlinks one account or all, and a later run links again', async () => {
    const linkIdentity = vi.fn(async () => ({}));
    const unlinkIdentity = vi.fn(async () => ({}));
    const env = envWith({ linkIdentity, unlinkIdentity });
    const actor = { platformUserId: 'plat_1' };
    await recordAclIdentityLink(env, actor, 'a@example.com');
    await removeAclIdentityLink(env, actor, 'A@example.com');
    expect(unlinkIdentity).toHaveBeenLastCalledWith({ kind: 'user', id: 'plat_1' }, 'a@example.com');
    await removeAclIdentityLink(env, actor);
    expect(unlinkIdentity).toHaveBeenLastCalledWith({ kind: 'user', id: 'plat_1' }, undefined);
    // The memo was cleared, so a reconnect links again.
    await recordAclIdentityLink(env, actor, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(2);
  });

  it("forgets only the named account, and only that owner's", async () => {
    const linkIdentity = vi.fn(async () => ({}));
    const unlinkIdentity = vi.fn(async () => ({}));
    const env = envWith({ linkIdentity, unlinkIdentity });
    await recordAclIdentityLink(env, { platformUserId: 'u1' }, 'a@example.com');
    await recordAclIdentityLink(env, { platformUserId: 'u1' }, 'b@example.com');
    await recordAclIdentityLink(env, { platformUserId: 'u2' }, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(3);
    await removeAclIdentityLink(env, { platformUserId: 'u1' }, 'a@example.com');
    await recordAclIdentityLink(env, { platformUserId: 'u1' }, 'b@example.com');
    await recordAclIdentityLink(env, { platformUserId: 'u2' }, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(3);
    await recordAclIdentityLink(env, { platformUserId: 'u1' }, 'a@example.com');
    expect(linkIdentity).toHaveBeenCalledTimes(4);
  });

  it('never throws when the platform refuses, and is a no-op on an older bridge', async () => {
    const unlinkIdentity = vi.fn(async () => { throw new Error('500'); });
    await expect(removeAclIdentityLink(envWith({ unlinkIdentity }), { agentId: 'agt_1' })).resolves.toBeUndefined();
    await expect(removeAclIdentityLink(envWith(), { agentId: 'agt_1' })).resolves.toBeUndefined();
  });
});

describe('types', () => {
  it("accepts an app's own env type and the app-sdk Actor without a cast", async () => {
    // A typical app env: required bridge methods, other SPRIGR surfaces, and
    // the CloudflareEnv index signature.
    interface AppEnv {
      DB: unknown;
      SPRIGR?: {
        data?: { put(): Promise<void> };
        acl?: {
          linkIdentity(owner: { kind: 'user' | 'agent'; id: string }, email: string): Promise<unknown>;
          unlinkIdentity(owner: { kind: 'user' | 'agent'; id: string }, email?: string): Promise<unknown>;
        };
      };
      [key: string]: unknown;
    }
    interface Actor { agentId?: string; platformUserId?: string; role?: string }
    const linkIdentity = vi.fn(async () => ({}));
    const env: AppEnv = { DB: null, SPRIGR: { acl: { linkIdentity, unlinkIdentity: vi.fn(async () => ({})) } } };
    const actor: Actor = { platformUserId: 'p', role: 'owner' };
    await recordAclIdentityLink(env, actor, 'a@example.com');
    await removeAclIdentityLink(env, actor);
    expect(linkIdentity).toHaveBeenCalledOnce();
  });
});

/**
 * The on_actor_retired hook helper (sprigr-team decision 0154). It is a
 * security boundary: its body names whose grant to revoke and whose data to
 * purge. These pin that a call carrying an actor is refused, that the key and
 * the identity fields must agree, and that a failure surfaces as a throw (a
 * platform retry) rather than a swallowed `{ ok: false }` the platform would
 * read as done.
 */
import { describe, it, expect, vi } from 'vitest';
import { actorKey } from '../src/actor';
import { actorRetiredHook, parseActorRetiredArgs, type ActorRetiredHookBody } from '../src/lifecycle';

const body: ActorRetiredHookBody = {
  trigger: 'actor_retired',
  install_id: 'inst_1',
  company_id: 'co_1',
  actor_key: 'u:user_t7sc3',
  platform_user_id: 'user_t7sc3',
  reason: 'user_id_superseded',
  successor_key: 'u:usr_0a60',
  storage_owner_ref: '0123456789abcdef0123456789abcdef',
  requested_by: 'agent:agt_1',
  requested_at: '2026-10-04T00:00:00.000Z',
  attempt: 2,
};

describe('parseActorRetiredArgs', () => {
  it('parses a user key into an actor whose actorKey round-trips', () => {
    const r = parseActorRetiredArgs(body);
    expect(r).toEqual({
      installId: 'inst_1', companyId: 'co_1', actorKey: 'u:user_t7sc3', actor: { platformUserId: 'user_t7sc3' },
      reason: 'user_id_superseded', successorKey: 'u:usr_0a60', storageOwnerRef: body.storage_owner_ref,
      requestedBy: 'agent:agt_1', requestedAt: Date.parse('2026-10-04T00:00:00.000Z'), attempt: 2,
    });
    expect(actorKey(r.actor)).toBe(r.actorKey);
  });

  it('parses an agent key', () => {
    const r = parseActorRetiredArgs({ ...body, actor_key: 'a:agt_9', platform_user_id: undefined, agent_id: 'agt_9', reason: 'agent_deleted' });
    expect(r.actor).toEqual({ agentId: 'agt_9' });
    expect(actorKey(r.actor)).toBe('a:agt_9');
  });

  it('refuses a call that carries an actor', () => {
    expect(() => parseActorRetiredArgs({ ...body, actor: { platformUserId: 'usr_attacker' } })).toThrow(/carries an actor/);
  });

  it('refuses a body whose identity fields disagree with the key', () => {
    expect(() => parseActorRetiredArgs({ ...body, platform_user_id: 'usr_someone_else' })).toThrow(/does not match/);
    expect(() => parseActorRetiredArgs({ ...body, actor_key: 'a:agt_1', platform_user_id: undefined, agent_id: 'agt_2' })).toThrow(/does not match/);
  });

  it('refuses malformed fields', () => {
    for (const bad of [
      null,
      { ...body, trigger: 'uninstall' },
      { ...body, actor_key: 'user_t7sc3' },
      { ...body, actor_key: 'u:a b' },
      { ...body, reason: 'because' },
      { ...body, storage_owner_ref: 'XYZ' },
      { ...body, requested_at: 'yesterday' },
      { ...body, install_id: '' },
    ]) {
      expect(() => parseActorRetiredArgs(bad)).toThrow(/on_actor_retired/);
    }
  });
});

describe('actorRetiredHook', () => {
  it('hands the parsed body to the handler and returns its result', async () => {
    const fn = vi.fn(async () => ({ done: true, revoked: 1 }));
    const hook = actorRetiredHook<{ DB: string }>(fn);
    await expect(hook(body, { DB: 'd1' })).resolves.toEqual({ done: true, revoked: 1 });
    expect(fn).toHaveBeenCalledWith({ DB: 'd1' }, expect.objectContaining({ actorKey: 'u:user_t7sc3' }));
  });

  it('throws, never swallows: a handler error or a missing done is a platform retry', async () => {
    await expect(actorRetiredHook(async () => { throw new Error('dropbox down'); })(body, {})).rejects.toThrow('dropbox down');
    await expect(actorRetiredHook(async () => ({}) as never)(body, {})).rejects.toThrow(/done: boolean/);
  });

  it('never runs the handler for a forged call', async () => {
    const fn = vi.fn(async () => ({ done: true }));
    await expect(actorRetiredHook(fn)({ ...body, actor: { agentId: 'agt_x' } }, {})).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

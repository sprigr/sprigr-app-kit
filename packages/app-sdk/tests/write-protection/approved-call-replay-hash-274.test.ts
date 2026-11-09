/**
 * An approved call must hash the same when the platform replays it (#274).
 *
 * The platform runs the approved args itself on a later turn, before the model
 * resumes, and redeems the grant only if the app's `_approval.hash` matches
 * the one on the card. The replay turn has not set its caller origin yet, so
 * the wrapper stamps `actor.surface: 'system'` where the asking turn stamped
 * `'portal'`. Hashing `actor` moved the hash, so the platform asked again, and
 * the re-approved call was then refused as changed. The args below are shaped
 * the way the platform stores and replays them: the model's input minus the
 * platform keys, with the wrapper's stamps added on each pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { requireApproval, dispatcherApproval, type ApprovalSpec, type RequireApprovalOptions } from '../../src/write-protection/require-approval';

interface Env { defaultStore: string }

const opts: RequireApprovalOptions<Env> = {
  scope: 'test',
  resolveConnection: async (env, args) => (typeof args.store === 'string' ? `${args.store}.myshopify.com` : env.defaultStore),
  connectionArgs: ['store'],
};

// Shaped like shopify_complete_draft_order: no `hash`, so the default applies.
const completeSpec: ApprovalSpec<Env> = {
  keys: ['id'],
  describe: (target) => ({ question: `Complete draft order ${target}?`, header: 'Shop' }),
};

const handlers = { complete_draft_order: vi.fn(async () => ({ ok: true })) };
const env: Env = { defaultStore: 'test-store.myshopify.com' };

/** What the card stores and the platform replays: the model's input, no platform keys. */
const storedArgs = { id: 'gid://shopify/DraftOrder/1', payment_pending: false };

const askTurnActor = {
  agentId: 'agent-1', platformUserId: 'bound-user', role: 'admin',
  surface: 'portal', personId: 'person-1', personSource: 'live',
};
const replayActor = { ...askTurnActor, surface: 'system' };

async function hashOf(args: Record<string, unknown>): Promise<string> {
  const gated = requireApproval(handlers, { complete_draft_order: completeSpec }, opts);
  const r = (await gated.complete_draft_order!(args, env)) as { _approval: { hash: string } };
  return r._approval.hash;
}

describe('an approved call hashes the same on the platform replay (#274)', () => {
  it('the asking turn, the replay and the re-card replay all give one hash', async () => {
    const asked = await hashOf({ ...storedArgs, actor: askTurnActor });
    const replay = await hashOf({ ...storedArgs, actor: replayActor });
    const recardReplay = await hashOf({ ...storedArgs, actor: replayActor });
    expect(replay).toBe(asked);
    expect(recardReplay).toBe(asked);
  });

  it('no other platform-stamped key moves the hash either', async () => {
    const plain = await hashOf(storedArgs);
    const stamped = await hashOf({
      ...storedArgs,
      actor: replayActor,
      caller: { installId: 'install-1', appSlug: 'other-app', companyId: 'company-1' },
      _write_key: 'write-key-1',
      _home: { provider: 'orders' },
      _approval_granted_hash: 'granted-hash-1',
    });
    expect(stamped).toBe(plain);
  });

  it('a real parameter change still moves the hash, stamps or not', async () => {
    const pending = await hashOf({ ...storedArgs, actor: askTurnActor });
    const paid = await hashOf({ ...storedArgs, payment_pending: true, actor: askTurnActor });
    expect(paid).not.toBe(pending);
  });

  it('a dispatcher on the flat envelope ignores the actor too', async () => {
    const gate = dispatcherApproval<Env>({ complete_draft_order: completeSpec }, opts);
    const ask = async (args: Record<string, unknown>) =>
      ((await gate.run('complete_draft_order', args, env, async () => ({ ok: true }))) as { _approval: { hash: string } })._approval.hash;
    const asked = await ask({ action: 'complete_draft_order', ...storedArgs, actor: askTurnActor });
    const replay = await ask({ action: 'complete_draft_order', ...storedArgs, actor: replayActor });
    expect(replay).toBe(asked);
    expect(await ask({ action: 'complete_draft_order', ...storedArgs, payment_pending: true, actor: replayActor })).not.toBe(asked);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { requireApproval, type ApprovalSpec, type RequireApprovalOptions } from '../../src/write-protection/require-approval';
import { APPROVAL_GRANTED_KEY } from '../../src/write-protection/types';
import { approvalHash, set } from '../../src/write-protection/approval-hash';

/** A multi-store env, pinned by `store`; the wrapper must resolve and pin inside. */
interface Env { defaultStore: string; pinned?: string }

function opts(overrides: Partial<RequireApprovalOptions<Env>> = {}): RequireApprovalOptions<Env> {
  return {
    scope: 'test-undo',
    resolveConnection: async (env, args) => (typeof args.store === 'string' ? `${args.store}.myshopify.com` : env.pinned ?? env.defaultStore),
    pinEnv: (env, connection) => ({ ...env, pinned: connection }),
    describeTarget: async (env, id) => `"Blue Snowboard" (${id}) via ${env.pinned}`,
    stampConnection: (r, c) => ({ ...(r as object), store: c }),
    ...overrides,
  };
}

const specs: Record<string, ApprovalSpec<Env>> = {
  delete_collection: {
    keys: ['collection_id', 'id'],
    describe: (target, _a, store) => ({ question: `Permanently delete collection ${target} on ${store}?`, header: 'Shop' }),
    undo: {
      resource: 'collection',
      fidelity: 'recreated',
      capture: async (env, id) => ({ id, title: 'Summer', capturedOn: env.pinned }),
      describe: (before) => `collection "${before.title}"`,
      warning: () => 'Recreates under a new id.',
    },
  },
  add_tags: {
    keys: ['id'],
    describe: (target) => ({ question: `Tag ${target}?`, header: 'Shop' }),
    hash: (a) => [set(a.tags)],
  },
};

describe('requireApproval', () => {
  const handlers = {
    delete_collection: vi.fn(async () => ({ ok: true, deleted: true })),
    add_tags: vi.fn(async () => ({ ok: true })),
  };

  it('throws when a spec names a tool missing from the registry', () => {
    expect(() => requireApproval({}, specs, opts())).toThrow(/not in the handler registry/);
  });

  it('throws when a spec declares undo but no journal is supplied', () => {
    expect(() => requireApproval(handlers, specs, opts())).toThrow(/no journal/);
  });

  it('ask pass: writes nothing, names the RESOLVED store on the card and hashes id + store', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_1' })) };
    const gated = requireApproval(handlers, specs, opts({ journal: () => journal }));
    const r = (await gated.delete_collection!({ collection_id: 'gid://C/1', store: 'eu' }, { defaultStore: 'us.myshopify.com' })) as { ok: boolean; _approval: Record<string, string> };
    expect(handlers.delete_collection).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    // label looked up THROUGH the pinned env, not the default
    expect(r._approval.question).toBe('Permanently delete collection "Blue Snowboard" (gid://C/1) via eu.myshopify.com on eu.myshopify.com?');
    expect(r._approval.hash).toBe(approvalHash('gid://C/1', 'eu.myshopify.com'));
  });

  it('hash is stable when the model reorders a set and omits confirm', async () => {
    const gated = requireApproval(handlers, { add_tags: specs.add_tags! }, opts());
    const a = (await gated.add_tags!({ id: 1, tags: ['a', 'b'], confirm: true }, { defaultStore: 'us' })) as { _approval: { hash: string } };
    const b = (await gated.add_tags!({ id: 1, tags: ['b', 'a'] }, { defaultStore: 'us' })) as { _approval: { hash: string } };
    expect(a._approval.hash).toBe(b._approval.hash);
  });

  it('a failed label lookup falls back to the raw id rather than guessing', async () => {
    const gated = requireApproval(handlers, { add_tags: specs.add_tags! }, opts({ describeTarget: async () => { throw new Error('boom'); } }));
    const r = (await gated.add_tags!({ id: 7 }, { defaultStore: 'us' })) as { _approval: { question: string } };
    expect(r._approval.question).toBe('Tag 7?');
  });

  it('granted pass: captures THROUGH the pinned store before the write, then offers _undo with the store named', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_9' })) };
    const gated = requireApproval(handlers, specs, opts({ journal: () => journal }));
    const r = (await gated.delete_collection!({ collection_id: 'gid://C/1', store: 'eu', [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us.myshopify.com' })) as Record<string, unknown>;
    expect(handlers.delete_collection).toHaveBeenCalledTimes(1);
    // the stamped flag never reaches the inner handler
    expect((handlers.delete_collection.mock.calls[0] as unknown[])[0]).toEqual({ collection_id: 'gid://C/1', store: 'eu' });
    expect(journal.captureBefore).toHaveBeenCalledWith({
      entity: 'delete_collection',
      originalId: 'gid://C/1',
      before: { id: 'gid://C/1', title: 'Summer', capturedOn: 'eu.myshopify.com' },
      connection: 'eu.myshopify.com',
    });
    expect(r.store).toBe('eu.myshopify.com');
    expect(r._undo).toEqual({
      fidelity: 'recreated',
      warning: 'Recreates under a new id.',
      describes: 'collection "Summer" on eu.myshopify.com',
      resource: 'collection',
      ref: 'cap_9',
    });
  });

  it('a failed capture does not block the write and offers no _undo', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_9' })) };
    const failing: Record<string, ApprovalSpec<Env>> = {
      delete_collection: { ...specs.delete_collection!, undo: { ...specs.delete_collection!.undo!, capture: async () => { throw new Error('404'); } } },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gated = requireApproval(handlers, failing, opts({ journal: () => journal }));
    const r = (await gated.delete_collection!({ collection_id: 'x', [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us' })) as Record<string, unknown>;
    expect(r.deleted).toBe(true);
    expect(r._undo).toBeUndefined();
    expect(journal.captureBefore).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capture failed/));
    warn.mockRestore();
  });

  it('never returns _undo when the journal could not store the copy', async () => {
    const journal = { captureBefore: vi.fn(async () => null) };
    const gated = requireApproval(handlers, specs, opts({ journal: () => journal }));
    const r = (await gated.delete_collection!({ collection_id: 'x', [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us' })) as Record<string, unknown>;
    expect(r._undo).toBeUndefined();
  });

  it('never returns _undo when the write itself reported ok: false', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap' })) };
    const h = { delete_collection: vi.fn(async () => ({ ok: false, error: 'nope' })) };
    const gated = requireApproval(h, { delete_collection: specs.delete_collection! }, opts({ journal: () => journal }));
    const r = (await gated.delete_collection!({ collection_id: 'x', [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us' })) as Record<string, unknown>;
    expect(r._undo).toBeUndefined();
    expect(journal.captureBefore).not.toHaveBeenCalled();
  });

  it('a caller-supplied granted flag of the wrong type is ignored', async () => {
    const gated = requireApproval(handlers, { add_tags: specs.add_tags! }, opts());
    const r = (await gated.add_tags!({ id: 1, [APPROVAL_GRANTED_KEY]: 'true' }, { defaultStore: 'us' })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

describe('requireApproval: _approval.count (decision 0039)', () => {
  const handlers = {
    delete_collection: vi.fn(async () => ({ ok: true })),
    add_tags: vi.fn(async () => ({ ok: true })),
    delete_many: vi.fn(async () => ({ ok: true })),
    delete_unkeyed: vi.fn(async () => ({ ok: true })),
  };
  const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_count' })) };
  const gated = requireApproval(handlers, {
    ...specs,
    delete_many: {
      keys: ['ids'],
      describe: (target) => ({ question: `Delete ${target}?`, header: 'Shop' }),
      count: (a) => (Array.isArray(a.ids) ? a.ids.length : 0),
    },
    delete_unkeyed: {
      keys: ['id'],
      describe: () => ({ question: 'Delete it?', header: 'Shop' }),
    },
  }, opts({ journal: () => journal }));
  const env: Env = { defaultStore: 'acme.myshopify.com' };

  it('reports 1 for a single-target spec that resolved an id', async () => {
    const r = (await gated.delete_collection({ collection_id: '9' }, env, {} as never)) as { _approval: { count?: number } };
    expect(r._approval.count).toBe(1);
  });

  it('uses the spec\'s own count for a batch action', async () => {
    const r = (await gated.delete_many({ ids: ['a', 'b', 'c'] }, env, {} as never)) as { _approval: { count?: number } };
    expect(r._approval.count).toBe(3);
  });

  it('reports nothing when no id resolved and no count was supplied', async () => {
    const r = (await gated.delete_unkeyed({}, env, {} as never)) as { _approval: { count?: number } };
    expect(r._approval.count).toBeUndefined();
  });

  it('drops a count that is not a finite non-negative number', async () => {
    const g = requireApproval(handlers, {
      delete_many: { keys: ['ids'], describe: () => ({ question: 'q', header: 'h' }), count: () => Number.NaN },
    }, opts());
    const r = (await g.delete_many({ ids: ['a'] }, env, {} as never)) as { _approval: { count?: number } };
    expect(r._approval.count).toBeUndefined();
  });
});


/**
 * sprigr-app-kit#44: one gate-level `resolveConnection` cannot describe two
 * families of write truthfully. A spec may override it, and the two consumers
 * of the resolved value (the card a person reads, the grant hash) must both
 * follow the spec's answer.
 */
describe('requireApproval: per-spec resolver overrides', () => {
  const handlers = {
    delete_collection: vi.fn(async () => ({ ok: true, deleted: true })),
    add_tags: vi.fn(async () => ({ ok: true })),
  };

  /** Addresses a global id: the store it lands on is not the caller's `store` arg. */
  const overrideSpecs: Record<string, ApprovalSpec<Env, Env>> = {
    delete_collection: {
      keys: ['collection_id', 'id'],
      resolveConnection: async () => 'primary.myshopify.com',
      describeTarget: async (env, id) => `"Archive" (${id}) via ${env.pinned}`,
      stampConnection: (r, c) => ({ ...(r as object), shop: c }),
      describe: (target, _a, store) => ({ question: `Permanently delete ${target} on ${store}?`, header: 'Shop' }),
    },
    add_tags: specs.add_tags!,
  };

  it("ask pass: the spec's resolveConnection and describeTarget win over the gate's, for the card AND the hash", async () => {
    const gated = requireApproval(handlers, overrideSpecs, opts());
    const r = (await gated.delete_collection!({ collection_id: 'gid://C/1', store: 'eu' }, { defaultStore: 'us.myshopify.com' })) as {
      _approval: { question: string; hash: string };
    };
    expect(handlers.delete_collection).not.toHaveBeenCalled();
    // The gate would have resolved eu.myshopify.com from the args and pinned to it.
    expect(r._approval.question).toBe('Permanently delete "Archive" (gid://C/1) via primary.myshopify.com on primary.myshopify.com?');
    expect(r._approval.hash).toBe('gid://C/1\u001fprimary.myshopify.com');
    expect(r._approval.hash).not.toContain('eu.myshopify.com');
  });

  it('ask pass: a spec with no override keeps the pre-change hash byte for byte', async () => {
    const gated = requireApproval(handlers, overrideSpecs, opts());
    const r = (await gated.add_tags!({ id: 1, tags: ['b', 'a'] }, { defaultStore: 'us.myshopify.com' })) as { _approval: { hash: string } };
    // Literal pinned from the pre-change implementation: raw id, gate-resolved
    // connection, then the sorted tag set.
    expect(r._approval.hash).toBe('1\u001fus.myshopify.com\u001fa\u001fb');
    expect(r._approval.hash).toBe(approvalHash(1, 'us.myshopify.com', set(['a', 'b'])));
  });

  it("granted pass: the spec's stampConnection stamps the spec-resolved connection", async () => {
    const gated = requireApproval(handlers, overrideSpecs, opts());
    const r = (await gated.delete_collection!({ collection_id: 'gid://C/1', store: 'eu', [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us.myshopify.com' })) as Record<string, unknown>;
    expect(handlers.delete_collection).toHaveBeenCalledTimes(1);
    expect(r.shop).toBe('primary.myshopify.com');
    expect(r.store).toBeUndefined();
  });

  it('granted pass: a spec with no override still stamps through the gate', async () => {
    const gated = requireApproval(handlers, overrideSpecs, opts());
    const r = (await gated.add_tags!({ id: 1, tags: ['a'], [APPROVAL_GRANTED_KEY]: true }, { defaultStore: 'us.myshopify.com' })) as Record<string, unknown>;
    expect(r.store).toBe('us.myshopify.com');
    expect(r.shop).toBeUndefined();
  });
});

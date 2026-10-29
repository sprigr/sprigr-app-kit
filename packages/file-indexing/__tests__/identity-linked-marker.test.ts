/**
 * sprigr-app-kit#227: on prod, two consecutive dropbox ticks 15 min apart
 * both paid acl.linkIdentity (727 and 1,219 ms; sprigr-team#13478). The only
 * guard was acl-identity-link's per-isolate memo, and a scheduled tick lands
 * on a fresh isolate. A store with the identity-linked column now records a
 * success, and a pass skips the call for IDENTITY_LINK_BACKOFF_MS after it.
 *
 * Every pass here resets the memo first, the way a fresh isolate starts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAclIdentityLinkMemoForTests } from '@sprigr/apps-acl-identity-link';
import { createD1FileIndexingStore, DEFAULT_FILE_INDEXING_SCHEMA_SQL, DEFAULT_FILE_INDEXING_STORE_CONFIG } from '../src/d1-store';
import { IDENTITY_LINK_BACKOFF_MS, indexActorFiles } from '../src/indexer';
import { makeFakePlatform } from './helpers/fake-env';
import { FakeSource, dropboxAdapter } from './helpers/fake-source';
import { ALICE, clock } from './helpers/setup';
import { makeSqliteD1 } from './helpers/sqlite-d1';

const SCOPE = { actor: ALICE, connectionId: 'dbx-acct-1' };
const MIGRATION = 'ALTER TABLE file_indexing ADD COLUMN identity_linked_at INTEGER;';

async function setup(opts: { column: boolean }) {
  const db = await makeSqliteD1(DEFAULT_FILE_INDEXING_SCHEMA_SQL + (opts.column ? MIGRATION : ''));
  const c = clock();
  const store = createD1FileIndexingStore(db, {
    ...DEFAULT_FILE_INDEXING_STORE_CONFIG,
    ...(opts.column ? { identityLinkedColumn: 'identity_linked_at' } : {}),
    now: c.now,
  });
  await store.enable(SCOPE, { connectedEmail: 'alice@corp.com' });
  const fp = makeFakePlatform();
  const src = new FakeSource();
  src.put({ id: 'a', name: 'a.txt', mime: 'text/plain', content: 'A' });
  const adapter = dropboxAdapter(src);
  /** One pass on a fresh isolate. */
  const pass = async () => {
    resetAclIdentityLinkMemoForTests();
    return indexActorFiles(adapter, store, fp.env, SCOPE, { now: c.now });
  };
  const linkCalls = () => fp.links.filter((l) => l.op === 'link');
  return { db, store, fp, c, pass, linkCalls };
}

beforeEach(() => resetAclIdentityLinkMemoForTests());

describe('a recorded identity link skips the call on later passes (sprigr-app-kit#227)', () => {
  it('two passes on fresh isolates link once, not twice', async () => {
    const t = await setup({ column: true });
    await t.pass();
    t.c.advance(15 * 60 * 1000);
    await t.pass();
    expect(t.linkCalls()).toEqual([{ op: 'link', owner: { kind: 'user', id: 'user_alice' }, email: 'alice@corp.com' }]);
    expect((await t.store.load(SCOPE))!.identity_linked_at).toBe(1_000_000);
  });

  it('a marker older than the back-off links again and is renewed', async () => {
    const t = await setup({ column: true });
    await t.pass();
    t.c.advance(IDENTITY_LINK_BACKOFF_MS);
    await t.pass();
    expect(t.linkCalls()).toHaveLength(2);
    expect((await t.store.load(SCOPE))!.identity_linked_at).toBe(1_000_000 + IDENTITY_LINK_BACKOFF_MS);
  });

  it('a new connected email clears the marker, so the next pass links the new address', async () => {
    const t = await setup({ column: true });
    await t.pass();
    await t.store.setConnectedEmail(SCOPE, 'alice@new.example');
    expect((await t.store.load(SCOPE))!.identity_linked_at).toBeNull();
    t.c.advance(60_000);
    await t.pass();
    expect(t.linkCalls().map((l) => l.email)).toEqual(['alice@corp.com', 'alice@new.example']);
  });

  it('disabling clears the marker', async () => {
    const t = await setup({ column: true });
    await t.pass();
    await t.store.disable(SCOPE);
    expect((await t.store.load(SCOPE))!.identity_linked_at).toBeNull();
  });

  it('a refusal clears the marker and records the refusal as before', async () => {
    const t = await setup({ column: true });
    await t.pass();
    t.c.advance(IDENTITY_LINK_BACKOFF_MS);
    const acl = (t.fp.env.SPRIGR as { acl: { linkIdentity: (...a: unknown[]) => Promise<unknown> } }).acl;
    acl.linkIdentity = async () => {
      throw new Error('env.SPRIGR.acl.linkIdentity failed: 404 owner_not_found');
    };
    await t.pass();
    const row = (await t.store.load(SCOPE))!;
    expect(row.identity_linked_at).toBeNull();
    expect(row.identity_link_refused_at).toBe(1_000_000 + IDENTITY_LINK_BACKOFF_MS);
  });

  it('a store without the column links on every pass, as before', async () => {
    const t = await setup({ column: false });
    await t.pass();
    t.c.advance(15 * 60 * 1000);
    await t.pass();
    expect(t.linkCalls()).toHaveLength(2);
    expect((await t.store.load(SCOPE))!.identity_linked_at).toBeNull();
  });
});

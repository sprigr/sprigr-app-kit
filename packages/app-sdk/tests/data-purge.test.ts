import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteSnapshotIds, makeDataClient, purgeIndexByPrefix, snapshotIndexIds } from '../src/data-purge';

const BRIDGE_ENV = { SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com/', SPRIGR_INSTALL_TOKEN: 'inst_1.sig' };

/** An in-memory index per logical name, served over the install-token routes. */
function stubPlatform(rows: Record<string, string[]>, opts: { truncateAt?: number; failDelete?: boolean } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const index = (body.index as string | undefined) ?? 'default';
    const ids = rows[index] ?? [];
    if (path === '/internal/wfp/data/list-ids') {
      const matched = ids.filter((id) => id.startsWith(String(body.prefix)));
      const cut = opts.truncateAt ?? Infinity;
      return Response.json({ ok: true, objectIDs: matched.slice(0, cut), total: matched.length, truncated: matched.length > cut });
    }
    if (path === '/internal/wfp/data/delete') {
      if (opts.failDelete) return Response.json({ error: 'company_admin_key_missing', detail: 'x' }, { status: 500 });
      const del = body.objectIDs as string[];
      rows[index] = ids.filter((id) => !del.includes(id));
      return Response.json({ ok: true, deleted: del.length, index });
    }
    return Response.json({ error: 'unexpected' }, { status: 404 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('makeDataClient', () => {
  it('returns null when neither the binding nor the install token is present', () => {
    expect(makeDataClient({})).toBeNull();
  });

  it('prefers the injected env.SPRIGR.data when it has the member', async () => {
    const listIds = vi.fn(async () => ({ objectIDs: ['a'], truncated: false }));
    const client = makeDataClient({ SPRIGR: { data: { listIds, delete: vi.fn() } }, ...BRIDGE_ENV });
    expect(client?.via).toBe('binding');
    expect(await client!.listIds('a', { index: 'cards' })).toEqual({ objectIDs: ['a'], truncated: false, total: 1 });
    expect(listIds).toHaveBeenCalledWith('a', { index: 'cards' });
  });

  it('falls back to the install-token routes when the binding is absent or lacks the member', async () => {
    const calls = stubPlatform({ cards: ['c1'] });
    const client = makeDataClient({ SPRIGR: { data: { import: vi.fn() } }, ...BRIDGE_ENV });
    expect(client?.via).toBe('http');
    expect((await client!.listIds('c', { index: 'cards' })).objectIDs).toEqual(['c1']);
    expect(await client!.delete(['c1'], { index: 'cards' })).toMatchObject({ deleted: 1 });
    expect(calls.map((c) => c.path)).toEqual(['/internal/wfp/data/list-ids', '/internal/wfp/data/delete']);
    expect(calls[1].body).toEqual({ objectIDs: ['c1'], index: 'cards' });
  });

  it('carries import, get and search over the bridge too', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(new URL(url).pathname);
      return Response.json({ ok: true, indexed: 1, object: null, hits: [], nbHits: 0 });
    });
    const client = makeDataClient(BRIDGE_ENV)!;
    await client.import([{ objectID: 'x' }]);
    await client.get('x');
    await client.search({ query: 'q' });
    expect(seen).toEqual(['/internal/wfp/data/import', '/internal/wfp/data/get', '/internal/wfp/data/search']);
  });
});

describe('snapshotIndexIds + deleteSnapshotIds', () => {
  it('lists every prefix per index, then deletes exactly that snapshot in chunks', async () => {
    const rows = { cards: ['trello:card:1', 'trello:card:2', 'trello:card:3'], boards: ['trello:board:1'] };
    const calls = stubPlatform(rows);
    const snap = await snapshotIndexIds(BRIDGE_ENV, [
      { prefix: 'trello:card:', index: 'cards' },
      { prefix: 'trello:board:', index: 'boards' },
    ]);
    expect(snap).toMatchObject({ truncated: false, listed: 4, via: 'http' });

    // A row written after the snapshot (the new account's first sync) survives.
    rows.cards.push('trello:card:new');
    const res = await deleteSnapshotIds(BRIDGE_ENV, snap, { chunk: 2 });
    expect(res).toEqual({ deleted: 4, listed: 4, truncated: false, via: 'http' });
    expect(rows).toEqual({ cards: ['trello:card:new'], boards: [] });
    expect(calls.filter((c) => c.path.endsWith('/delete')).map((c) => (c.body.objectIDs as string[]).length)).toEqual([2, 1, 1]);
  });

  it('dedupes ids a second prefix lists again', async () => {
    stubPlatform({ default: ['https://a', 'https://b'] });
    const snap = await snapshotIndexIds(BRIDGE_ENV, ['https://', 'https://a']);
    expect(snap.listed).toBe(2);
  });

  it('reports a truncated listing instead of hiding it', async () => {
    stubPlatform({ default: ['u:1', 'u:2', 'u:3'] }, { truncateAt: 2 });
    const res = await purgeIndexByPrefix(BRIDGE_ENV, ['u:']);
    expect(res).toMatchObject({ deleted: 2, truncated: true });
  });

  it('with no data path at all, reports none and does nothing', async () => {
    const res = await purgeIndexByPrefix({}, ['u:']);
    expect(res).toEqual({ deleted: 0, listed: 0, truncated: false, via: 'none' });
  });
});

describe('purgeIndexByPrefix never throws', () => {
  it('returns the error and what it managed when a delete is refused', async () => {
    stubPlatform({ default: ['u:1'] }, { failDelete: true });
    const res = await purgeIndexByPrefix(BRIDGE_ENV, ['u:']);
    expect(res.deleted).toBe(0);
    expect(res.listed).toBe(1);
    expect(res.error).toMatch(/company_admin_key_missing/);
  });

  it('returns the error when the listing fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    const res = await purgeIndexByPrefix(BRIDGE_ENV, ['u:']);
    expect(res).toMatchObject({ deleted: 0, listed: 0, via: 'http' });
    expect(res.error).toMatch(/network down/);
  });

  it('rejects an empty prefix rather than listing the whole index', async () => {
    stubPlatform({ default: ['u:1'] });
    const res = await purgeIndexByPrefix(BRIDGE_ENV, ['']);
    expect(res.deleted).toBe(0);
    expect(res.error).toMatch(/prefix/);
  });
});

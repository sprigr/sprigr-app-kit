import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainRoute,
  type SampleObject,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';

const SEED: SampleSeed = {
  items: {
    idField: 'ItemID',
    items: [
      { ItemID: 'i1', Status: 'A', Price: 1 },
      { ItemID: 'i2', Status: 'A', Price: 3 },
      { ItemID: 'i3', Status: 'A', Price: 5 },
      { ItemID: 'i4', Status: 'B', Price: 7 },
      { ItemID: 'i5', Status: 'B', Price: 9 },
    ],
  },
};

const PAGED: PlainRoute = {
  method: 'GET',
  path: '/items',
  op: 'list',
  resource: 'items',
  wrap: 'items',
  filters: { status: 'Status' },
  query: { min: (v, items) => items.filter((i) => Number(i.Price) >= Number(v)) },
  page: { param: 'page', size: 2, first: 1, always: true },
  envelope: {
    'pagination.page': 'page',
    'pagination.pageSize': 'pageSize',
    'pagination.pageCount': 'pageCount',
    'pagination.itemCount': 'total',
    'meta.count': 'count',
  },
};

const ROUTES: PlainRoute[] = [
  PAGED,
  { method: 'GET', path: '/plain', op: 'list', resource: 'items', wrap: 'items', page: { param: 'page', size: 2, first: 1 } },
];

/** Built per test, so a throwing build fails each row by name. */
function install() {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: plainDialect({ base: '/api', routes: ROUTES }), store });
  return { sim };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const ids = (b: Record<string, unknown>) => ((b.items ?? []) as SampleObject[]).map((i) => i.ItemID);

describe('envelope fields beside the wrapped list', () => {
  it('answers page first with page.always and no page parameter', async () => {
    const { sim } = install();
    const b = await body(await sim.fetch(`${BASE}/items`));
    expect(ids(b)).toEqual(['i1', 'i2']);
    expect((b.pagination as Record<string, unknown> | undefined)?.page).toBe(1);
  });

  it('fills every declared field from the page', async () => {
    const { sim } = install();
    expect(await body(await sim.fetch(`${BASE}/items?page=2`))).toEqual({
      items: [SEED.items?.items[2], SEED.items?.items[3]],
      pagination: { page: 2, pageSize: 2, pageCount: 3, itemCount: 5 },
      meta: { count: 2 },
    });
  });

  it('counts the total after filters and query functions, before paging', async () => {
    const { sim } = install();
    const some = await body(await sim.fetch(`${BASE}/items?status=A&min=3`));
    expect(ids(some)).toEqual(['i2', 'i3']);
    expect(some.pagination).toEqual({ page: 1, pageSize: 2, pageCount: 1, itemCount: 2 });
    const none = await body(await sim.fetch(`${BASE}/items?status=Z`));
    expect(none).toEqual({ items: [], pagination: { page: 1, pageSize: 2, pageCount: 0, itemCount: 0 }, meta: { count: 0 } });
  });

  it('answers a page past the end with no items and the same total', async () => {
    const { sim } = install();
    expect(await body(await sim.fetch(`${BASE}/items?page=4`))).toEqual({
      items: [],
      pagination: { page: 4, pageSize: 2, pageCount: 3, itemCount: 5 },
      meta: { count: 0 },
    });
  });

  it('answers a list route with no envelope exactly as before', async () => {
    const { sim } = install();
    const all = await body(await sim.fetch(`${BASE}/plain`));
    expect(Object.keys(all)).toEqual(['items']);
    expect(ids(all)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    const paged = await body(await sim.fetch(`${BASE}/plain?page=1`));
    expect(Object.keys(paged)).toEqual(['items']);
    expect(ids(paged)).toEqual(['i1', 'i2']);
  });
});

describe('envelope fields at build', () => {
  const build = (route: PlainRoute) => () => plainDialect({ base: '/api', routes: [route] });
  const throws = (fn: () => unknown, re: RegExp) => {
    expect(fn).toThrow(TypeError);
    expect(fn).toThrow(re);
  };
  const plain = { method: 'GET', path: '/items', op: 'list', resource: 'items', wrap: 'items' } as const;

  it('throws for each envelope it cannot fill, and builds a valid one', () => {
    throws(build({ method: 'GET', path: '/items/:id', op: 'get', resource: 'items', wrap: 'items', envelope: { total: 'total' } }), /envelope is for a list route/);
    throws(build({ ...plain, wrap: undefined, envelope: { total: 'total' } }), /envelope needs wrap/);
    throws(build({ ...plain, envelope: { 'items.total': 'total' } }), /starts at the wrap key/);
    throws(build({ ...plain, envelope: { pagination: 'total', 'pagination.count': 'count' } }), /overlap/);
    throws(build({ ...plain, envelope: { 'pagination..total': 'total' } }), /empty segment/);
    throws(build({ ...plain, envelope: { total: 'sum' as 'total' } }), /not an envelope value/);
    throws(build({ ...plain, page: { param: 'page', size: 2 }, envelope: { page: 'page' } }), /needs page\.always/);
    throws(build({ ...plain, envelope: { pageSize: 'pageSize' } }), /needs page\.always/);
    expect(build(PAGED)).not.toThrow();
  });
});

describe('page numbers at build', () => {
  const plain = { method: 'GET', path: '/items', op: 'list', resource: 'items', wrap: 'items' } as const;
  const paged = (page: { size: number; first?: number; always?: boolean }) => () =>
    plainDialect({ base: '/api', routes: [{ ...plain, page: { param: 'page', ...page } }] });
  const throws = (fn: () => unknown, re: RegExp) => {
    expect(fn).toThrow(TypeError);
    expect(fn).toThrow(re);
  };

  it('throws for a page size that is not a whole number above 0', () => {
    const re = /page\.size must be a whole number above 0/;
    throws(paged({ size: 0 }), re);
    throws(paged({ size: -1 }), re);
    throws(paged({ size: 1.5 }), re);
    throws(paged({ size: Number.NaN }), re);
    throws(() => plainDialect({ base: '/api', routes: [{ ...plain, page: { param: 'page', size: 0, always: true }, envelope: { 'pagination.pageCount': 'pageCount' } }] }), re);
  });

  it('throws for a first page that is not a whole number of 0 or more', () => {
    const re = /page\.first must be a whole number of 0 or more/;
    throws(paged({ size: 2, first: -1 }), re);
    throws(paged({ size: 2, first: 0.5 }), re);
  });

  it('builds and answers with size 1 and first 0', async () => {
    expect(paged({ size: 1, first: 0 })).not.toThrow();
    const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
    const store = createSampleStore({ db: d1.db, table: TABLE });
    const sim = createSimulator({ seed: SEED, dialect: paged({ size: 1, first: 0 })(), store });
    expect(ids(await body(await sim.fetch(`${BASE}/items?page=0`)))).toEqual(['i1']);
    expect(ids(await body(await sim.fetch(`${BASE}/items?page=4`)))).toEqual(['i5']);
  });
});

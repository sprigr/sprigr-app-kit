import { describe, expect, it, vi } from 'vitest';
import {
  createSampleStore,
  createSampleSwitch,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  sampleAwareFetch,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';

const SEED: SampleSeed = {
  items: {
    idField: 'ItemID',
    items: [
      { ItemID: 'i1', Name: 'Bolt', Status: 'ACTIVE', Price: 5 },
      { ItemID: 'i2', Name: 'Anchor', Status: 'ARCHIVED', Price: 12 },
      { ItemID: 'i3', Name: 'Clamp', Status: 'ACTIVE', Price: 3 },
    ],
  },
};
const SEED_SNAPSHOT = JSON.stringify(SEED);

/** Built per test, so a throwing build fails each row by name. */
const dialect = () => plainDialect({
  base: '/api',
  routes: [
    {
      method: 'GET', path: '/items', op: 'list', resource: 'items', wrap: 'Items',
      filters: { status: 'Status' }, sort: { param: 'order' }, page: { param: 'page', size: 2, first: 1 },
    },
    { method: 'GET', path: '/items/:id', op: 'get', resource: 'items', wrap: 'Items' },
    { method: 'POST', path: '/items', op: 'create', resource: 'items', wrap: 'Items', bodyKey: 'Items' },
    { method: 'POST', path: '/items/:id', op: 'update', resource: 'items', wrap: 'Items', bodyKey: 'Items' },
    { method: 'DELETE', path: '/items/:id', op: 'delete', resource: 'items' },
  ],
});

/** One install: its own database, with the sample flag on. */
function install() {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: dialect(), store });
  return { d1, store, sim };
}

async function items(res: Response): Promise<Array<Record<string, unknown>>> {
  const body = (await res.json()) as { Items: Array<Record<string, unknown>> };
  return body.Items;
}

const ids = (list: Array<Record<string, unknown>>) => list.map((i) => i.ItemID);

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('plain dialect: reads', () => {
  it('lists every seed object in the declared envelope', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items`);
    expect(res.status).toBe(200);
    expect(ids(await items(res))).toEqual(['i1', 'i2', 'i3']);
  });

  it('gets one object by id, in the envelope', async () => {
    const { sim } = install();
    expect(ids(await items(await sim.fetch(`${BASE}/items/i2`)))).toEqual(['i2']);
  });

  it('answers 404 for an id the sample does not have', async () => {
    const { sim } = install();
    expect((await sim.fetch(`${BASE}/items/nope`)).status).toBe(404);
  });

  it('filters on a declared query parameter', async () => {
    const { sim } = install();
    expect(ids(await items(await sim.fetch(`${BASE}/items?status=ACTIVE`)))).toEqual(['i1', 'i3']);
  });

  it('sorts ascending and descending, numbers as numbers', async () => {
    const { sim } = install();
    expect(ids(await items(await sim.fetch(`${BASE}/items?order=Price`)))).toEqual(['i3', 'i1', 'i2']);
    expect(ids(await items(await sim.fetch(`${BASE}/items?order=${encodeURIComponent('Name DESC')}`)))).toEqual(['i3', 'i1', 'i2']);
  });

  it('pages only when the page parameter is sent', async () => {
    const { sim } = install();
    expect(ids(await items(await sim.fetch(`${BASE}/items?page=1`)))).toEqual(['i1', 'i2']);
    expect(ids(await items(await sim.fetch(`${BASE}/items?page=2`)))).toEqual(['i3']);
    expect(ids(await items(await sim.fetch(`${BASE}/items?page=3`)))).toEqual([]);
  });
});

describe('plain dialect: writes land on this install only', () => {
  it('creates every object in one request, each readable after', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items`, post({ Items: [{ Name: 'Hook', Status: 'ACTIVE', Price: 1 }, { Name: 'Nut', Status: 'ACTIVE', Price: 2 }] }));
    expect(res.status).toBe(200);
    const created = await items(res);
    expect(created.map((i) => i.Name)).toEqual(['Hook', 'Nut']);
    for (const c of created) {
      expect(typeof c.ItemID).toBe('string');
      expect(ids(await items(await sim.fetch(`${BASE}/items/${String(c.ItemID)}`)))).toEqual([c.ItemID]);
    }
    expect((await items(await sim.fetch(`${BASE}/items`))).length).toBe(5);
  });

  it('updates by merging fields into the object', async () => {
    const { sim } = install();
    await sim.fetch(`${BASE}/items/i1`, post({ Items: [{ Price: 99 }] }));
    const [got] = await items(await sim.fetch(`${BASE}/items/i1`));
    expect(got).toEqual({ ItemID: 'i1', Name: 'Bolt', Status: 'ACTIVE', Price: 99 });
  });

  it('deletes: the object is gone from list and get', async () => {
    const { sim } = install();
    expect((await sim.fetch(`${BASE}/items/i2`, { method: 'DELETE' })).ok).toBe(true);
    expect((await sim.fetch(`${BASE}/items/i2`)).status).toBe(404);
    expect(ids(await items(await sim.fetch(`${BASE}/items`)))).toEqual(['i1', 'i3']);
  });

  it('never changes the shipped seed', async () => {
    const { sim } = install();
    await sim.fetch(`${BASE}/items/i1`, post({ Items: [{ Price: 99 }] }));
    await sim.fetch(`${BASE}/items/i3`, { method: 'DELETE' });
    expect(JSON.stringify(SEED)).toBe(SEED_SNAPSHOT);
  });

  it('a write on one install is not seen by another', async () => {
    const a = install();
    const b = install();
    await a.sim.fetch(`${BASE}/items/i1`, post({ Items: [{ Price: 99 }] }));
    await a.sim.fetch(`${BASE}/items`, post({ Items: [{ Name: 'Hook', Status: 'ACTIVE', Price: 1 }] }));
    const [bGot] = await items(await b.sim.fetch(`${BASE}/items/i1`));
    expect(bGot?.Price).toBe(5);
    expect((await items(await b.sim.fetch(`${BASE}/items`))).length).toBe(3);
  });
});

describe('an unrouted request', () => {
  it('is refused as not simulated, naming method and path, and never reaches the network', async () => {
    const { store, sim } = install();
    const network = vi.fn(async () => new Response('network'));
    const fetchImpl = sampleAwareFetch({ sampleSwitch: createSampleSwitch(store), simulator: sim, network });
    const err = await fetchImpl(`${BASE}/reports/aged`, { method: 'PATCH' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotSimulatedError);
    expect((err as NotSimulatedError).code).toBe('not_simulated');
    expect((err as NotSimulatedError).method).toBe('PATCH');
    expect((err as NotSimulatedError).path).toBe('/api/reports/aged');
    expect(network).not.toHaveBeenCalled();
  });

  it('a path outside the dialect base is not simulated either', async () => {
    const { sim } = install();
    const err = await sim.fetch('https://vendor.example/other/items').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotSimulatedError);
    expect((err as NotSimulatedError).code).toBe('not_simulated');
    expect((err as NotSimulatedError).method).toBe('GET');
    expect((err as NotSimulatedError).path).toBe('/other/items');
  });
});

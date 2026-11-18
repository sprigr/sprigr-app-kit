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
  type SampleObject,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const OVERLAY_READ = /^SELECT id, body, deleted FROM sample_objects WHERE resource = \?$/;
const WRITE = /^INSERT INTO sample_objects /;

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

/** An app-supplied query function: `cheap` keeps items under 10, anything else it cannot apply. */
const where = (value: string, items: SampleObject[]): SampleObject[] | null =>
  value === 'cheap' ? items.filter((i) => Number(i.Price) < 10) : null;

/** Built per test, so a throwing build fails each row by name. */
const dialect = () =>
  plainDialect({
    base: '/api',
    routes: [
      {
        method: 'GET', path: '/items', op: 'list', resource: 'items', wrap: 'Items',
        filters: { status: 'Status' }, query: { where }, sort: { param: 'order' }, page: { param: 'page', size: 2, first: 1 },
      },
      { method: 'GET', path: '/items/:id', op: 'get', resource: 'items', wrap: 'Items' },
      { method: 'POST', path: '/items', op: 'create', resource: 'items', wrap: 'Items', bodyKey: 'Items' },
      { method: 'POST', path: '/items/:id', op: 'update', resource: 'items', wrap: 'Items', bodyKey: 'Items' },
      { method: 'DELETE', path: '/items/:id', op: 'delete', resource: 'items' },
    ],
  });

function install() {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: dialect(), store });
  return { d1, store, sim };
}

const count = (statements: string[], re: RegExp) => statements.filter((s) => re.test(s)).length;

async function ids(res: Response): Promise<unknown[]> {
  const body = (await res.json()) as { Items: Array<Record<string, unknown>> };
  return body.Items.map((i) => i.ItemID);
}

/** The refusal a request ends in, or null when it was answered. */
async function refusal(p: Promise<Response>): Promise<NotSimulatedError | null> {
  return p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof NotSimulatedError) return e;
      throw e;
    },
  );
}

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});

describe('query parameters: declared and applied, or refused', () => {
  it('an undeclared parameter on a list is refused before any overlay read, and never reaches the network', async () => {
    const { d1, store, sim } = install();
    const network = vi.fn(async () => new Response('network'));
    const fetchImpl = sampleAwareFetch({ sampleSwitch: createSampleSwitch(store), simulator: sim, network });
    const err = await refusal(fetchImpl(`${BASE}/items?colour=red`));
    expect(err?.reason).toBe('query');
    expect(err?.method).toBe('GET');
    expect(err?.path).toBe('/api/items');
    expect(network).not.toHaveBeenCalled();
    expect(count(d1.statements, OVERLAY_READ)).toBe(0);
  });

  it('an undeclared parameter on a get is refused', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items/i1?colour=red`)))?.reason).toBe('query');
  });

  it('an undeclared parameter on an update is refused and nothing is written', async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items/i1?colour=red`, post({ Items: [{ Price: 99 }] }))))?.reason).toBe('query');
    expect(count(d1.statements, WRITE)).toBe(0);
    const res = await sim.fetch(`${BASE}/items/i1`);
    expect(((await res.json()) as { Items: Array<{ Price: number }> }).Items[0]?.Price).toBe(5);
  });

  it('an undeclared parameter on a delete is refused and the object stays', async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items/i2?colour=red`, { method: 'DELETE' })))?.reason).toBe('query');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect((await sim.fetch(`${BASE}/items/i2`)).status).toBe(200);
  });

  it('a declared query function is applied', async () => {
    const { sim } = install();
    expect(await ids(await sim.fetch(`${BASE}/items?where=cheap`))).toEqual(['i1', 'i3']);
  });

  it('a query function that cannot apply the value is refused', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items?where=${encodeURIComponent('Price>4')}`)))?.reason).toBe('query');
  });

  it('a query function runs before sort and page', async () => {
    const { sim } = install();
    // Paged first, page 1 of all three by price would be i2, i1, and the function would leave i1 alone.
    expect(await ids(await sim.fetch(`${BASE}/items?where=cheap&order=${encodeURIComponent('Price DESC')}&page=1`))).toEqual(['i1', 'i3']);
  });

  it('a parameter sent twice is refused', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items?status=ACTIVE&status=ARCHIVED`)))?.reason).toBe('query');
    expect((await refusal(sim.fetch(`${BASE}/items?page=1&page=2`)))?.reason).toBe('query');
  });

  it('a sort value other than Field, Field ASC or Field DESC is refused', async () => {
    const { sim } = install();
    for (const order of ['Price DESC,Name', 'Name,Price DESC', 'Price SIDEWAYS', 'Price DESC Name']) {
      expect((await refusal(sim.fetch(`${BASE}/items?order=${encodeURIComponent(order)}`)))?.reason, order).toBe('query');
    }
  });

  it('Field ASC sorts ascending', async () => {
    const { sim } = install();
    expect(await ids(await sim.fetch(`${BASE}/items?order=${encodeURIComponent('Price ASC')}`))).toEqual(['i3', 'i1', 'i2']);
  });

  it('a page value that is not a whole number at or above the first page is refused', async () => {
    const { sim } = install();
    for (const page of ['abc', '0', '1.5', '-1', '']) {
      expect((await refusal(sim.fetch(`${BASE}/items?page=${page}`)))?.reason, `page=${page}`).toBe('query');
    }
  });
});

describe('a request the engine cannot answer as JSON', () => {
  it('a get that prefers a PDF is refused', async () => {
    const { sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/items/i1`, { headers: { accept: 'application/pdf' } }));
    expect(err?.reason).toBe('accept');
    expect(err?.path).toBe('/api/items/i1');
  });

  it('a PDF first with a wildcard fallback is still refused', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items`, { headers: { accept: 'application/pdf, */*' } })))?.reason).toBe('accept');
  });

  it('the highest weight decides, not the order', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items`, { headers: { accept: 'application/json;q=0.2, application/pdf' } })))?.reason).toBe('accept');
    expect((await sim.fetch(`${BASE}/items`, { headers: { accept: 'application/pdf;q=0.5, application/json' } })).status).toBe(200);
  });

  it('JSON, a JSON suffix type and wildcards are answered', async () => {
    const { sim } = install();
    for (const accept of ['application/json', 'application/json, text/plain', 'application/vnd.api+json', 'application/*', '*/*']) {
      expect((await sim.fetch(`${BASE}/items`, { headers: { accept } })).status, accept).toBe(200);
    }
  });

  it('an Accept on a Request input is read too', async () => {
    const { sim } = install();
    const req = new Request(`${BASE}/items/i1`, { headers: { accept: 'application/pdf' } });
    expect((await refusal(sim.fetch(req)))?.reason).toBe('accept');
  });

  it('a create with a multipart body is refused, not answered 400, and writes nothing', async () => {
    const { d1, sim } = install();
    const form = new FormData();
    form.set('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    expect((await refusal(sim.fetch(`${BASE}/items`, { method: 'POST', body: form })))?.reason).toBe('content_type');
    const declared = post({ Items: [{ Name: 'Hook' }] }, { 'content-type': 'multipart/form-data; boundary=x' });
    expect((await refusal(sim.fetch(`${BASE}/items`, declared)))?.reason).toBe('content_type');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('an update with a non-JSON content type is refused and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/items/i1`, post({ Items: [{ Price: 99 }] }, { 'content-type': 'text/plain' })));
    expect(err?.reason).toBe('content_type');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a write with a JSON suffix content type is answered', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1`, post({ Items: [{ Price: 99 }] }, { 'content-type': 'application/vnd.api+json; charset=utf-8' }));
    expect(res.status).toBe(200);
  });
});

describe('why a request was not simulated', () => {
  it('an unrouted request carries reason no_route', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/reports/aged`)))?.reason).toBe('no_route');
  });

  it('a request outside the dialect base carries reason no_route', async () => {
    const { sim } = install();
    expect((await refusal(sim.fetch('https://vendor.example/other/items')))?.reason).toBe('no_route');
  });
});

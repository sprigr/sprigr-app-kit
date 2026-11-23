import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainRoute,
  type ResourceRules,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const WRITE = /^INSERT INTO sample_objects /;

/** Every seed object carries ItemID and Name; only i1 carries Note, so a replace can drop it. */
const SEED: SampleSeed = {
  items: {
    idField: 'ItemID',
    items: [
      { ItemID: 'i1', Name: 'Bolt', Note: 'old' },
      { ItemID: 'i2', Name: 'Nut' },
    ],
  },
};

const ROUTES: PlainRoute[] = [
  { method: 'GET', path: '/items/:id', op: 'get', resource: 'items' },
  { method: 'POST', path: '/items/:id', op: 'update', resource: 'items', replace: true },
  { method: 'PATCH', path: '/items/:id', op: 'update', resource: 'items' },
  { method: 'POST', path: '/items', op: 'create', resource: 'items', upsert: true, replace: true },
];

function install() {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: plainDialect({ base: '/api', routes: ROUTES }), store });
  return { d1, sim };
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

const count = (statements: string[], re: RegExp) => statements.filter((s) => re.test(s)).length;
const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getItem = async (sim: ReturnType<typeof install>['sim'], id: string) => (await sim.fetch(`${BASE}/items/${id}`)).json();

describe('an update route that declares replace', () => {
  it('stores and answers only the body fields plus the id', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1`, send('POST', { Name: 'Hook' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i1', Name: 'Hook' });
    expect(await getItem(sim, 'i1')).toEqual({ ItemID: 'i1', Name: 'Hook' });
  });

  it('a replace upsert onto an existing id replaces the object', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items`, send('POST', { ItemID: 'i1', Name: 'Hook' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i1', Name: 'Hook' });
    expect(await getItem(sim, 'i1')).toEqual({ ItemID: 'i1', Name: 'Hook' });
  });

  it('a replace body missing a field every seed object carries is refused computed, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/items/i1`, send('POST', { Note: 'new' })));
    expect(err?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await getItem(sim, 'i1')).toEqual({ ItemID: 'i1', Name: 'Bolt', Note: 'old' });
  });

  it('an update route without replace still merges', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1`, send('PATCH', { Name: 'Hook' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i1', Name: 'Hook', Note: 'old' });
  });
});

describe('replace is only for an update route or an upsert create route', () => {
  const resources: Record<string, ResourceRules> = { items: { computed: [], complete: (obj) => obj } };
  const build = (route: PlainRoute) => () => plainDialect({ base: '/api', routes: [route], resources });

  it('replace on a list, get, delete, action or non-upsert create route throws at build', () => {
    const routes: PlainRoute[] = [
      { method: 'GET', path: '/items', op: 'list', resource: 'items', replace: true },
      { method: 'GET', path: '/items/:id', op: 'get', resource: 'items', replace: true },
      { method: 'DELETE', path: '/items/:id', op: 'delete', resource: 'items', replace: true },
      { method: 'POST', path: '/items/:id/approve', op: 'action', resource: 'items', action: 'approve', answer: 'object', replace: true },
      { method: 'PUT', path: '/items', op: 'create', resource: 'items', replace: true },
    ];
    for (const route of routes) expect(build(route), `${route.method} ${route.path}`).toThrow(TypeError);
  });

  it('replace on an update route or an upsert create route builds', () => {
    expect(build({ method: 'POST', path: '/items/:id', op: 'update', resource: 'items', replace: true })).not.toThrow();
    expect(build({ method: 'POST', path: '/items', op: 'create', resource: 'items', upsert: true, replace: true })).not.toThrow();
  });
});

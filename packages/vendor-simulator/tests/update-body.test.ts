import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainRoute,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const WRITE = /^INSERT INTO sample_objects /;

/** Items take a bare body; contacts take theirs under a key. */
const SEED: SampleSeed = {
  items: { idField: 'ItemID', items: [{ ItemID: 'i1', Name: 'Bolt', Price: 5 }] },
  contacts: { idField: 'ContactID', items: [{ ContactID: 'c1', Name: 'Ann' }] },
};

const ROUTES: PlainRoute[] = [
  { method: 'GET', path: '/items/:id', op: 'get', resource: 'items' },
  { method: 'POST', path: '/items/:id', op: 'update', resource: 'items' },
  { method: 'GET', path: '/contacts/:id', op: 'get', resource: 'contacts', wrap: 'Contacts' },
  { method: 'POST', path: '/contacts/:id', op: 'update', resource: 'contacts', wrap: 'Contacts', bodyKey: 'Contacts' },
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
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('an update body carries one object', () => {
  it('an update with two objects, bare or under its key, is refused body, and nothing is written', async () => {
    const bare = install();
    const err = await refusal(bare.sim.fetch(`${BASE}/items/i1`, post([{ Name: 'Hook' }, { Name: 'Line' }])));
    expect(err?.reason).toBe('body');
    expect(count(bare.d1.statements, WRITE)).toBe(0);
    expect(await (await bare.sim.fetch(`${BASE}/items/i1`)).json()).toEqual({ ItemID: 'i1', Name: 'Bolt', Price: 5 });

    const keyed = install();
    const keyedErr = await refusal(keyed.sim.fetch(`${BASE}/contacts/c1`, post({ Contacts: [{ Name: 'Bo' }, { Name: 'Cy' }] })));
    expect(keyedErr?.reason).toBe('body');
    expect(count(keyed.d1.statements, WRITE)).toBe(0);
    expect(await (await keyed.sim.fetch(`${BASE}/contacts/c1`)).json()).toEqual({ Contacts: [{ ContactID: 'c1', Name: 'Ann' }] });
  });

  it('an update with one bare object still answers', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1`, post({ Name: 'Hook' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i1', Name: 'Hook', Price: 5 });
  });

  it('an update with one object in a one-element array, bare or under its key, still answers', async () => {
    const bare = install();
    const res = await bare.sim.fetch(`${BASE}/items/i1`, post([{ Name: 'Hook' }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i1', Name: 'Hook', Price: 5 });

    const keyed = install();
    const keyedRes = await keyed.sim.fetch(`${BASE}/contacts/c1`, post({ Contacts: [{ Name: 'Bo' }] }));
    expect(keyedRes.status).toBe(200);
    expect(await keyedRes.json()).toEqual({ Contacts: [{ ContactID: 'c1', Name: 'Bo' }] });
  });
});

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

/** Items take a bare body; contacts take theirs under a key; notes are also wrapped in the answer. */
const SEED: SampleSeed = {
  items: { idField: 'ItemID', items: [{ ItemID: 'i1', Name: 'Bolt' }] },
  contacts: { idField: 'ContactID', items: [{ ContactID: 'c1', Name: 'Ann' }] },
  notes: { idField: 'NoteID', items: [{ NoteID: 'n1', Text: 'Call back' }] },
};

const ROUTES: PlainRoute[] = [
  { method: 'GET', path: '/items', op: 'list', resource: 'items' },
  { method: 'PUT', path: '/items', op: 'create', resource: 'items' },
  { method: 'GET', path: '/contacts', op: 'list', resource: 'contacts' },
  { method: 'PUT', path: '/contacts', op: 'create', resource: 'contacts', bodyKey: 'Contacts' },
  { method: 'GET', path: '/notes', op: 'list', resource: 'notes', wrap: 'Notes' },
  { method: 'PUT', path: '/notes', op: 'create', resource: 'notes', wrap: 'Notes', bodyKey: 'Notes' },
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
const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a create body carries at least one object', () => {
  it('a bare empty array is refused body, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/items`, put([])));
    expect(err?.reason).toBe('body');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await (await sim.fetch(`${BASE}/items`)).json()).toEqual([{ ItemID: 'i1', Name: 'Bolt' }]);
  });

  it('an empty array under the body key is refused body, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/contacts`, put({ Contacts: [] })));
    expect(err?.reason).toBe('body');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await (await sim.fetch(`${BASE}/contacts`)).json()).toEqual([{ ContactID: 'c1', Name: 'Ann' }]);
  });

  it('an empty array under the body key of a wrapped route is refused body, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/notes`, put({ Notes: [] })));
    expect(err?.reason).toBe('body');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await (await sim.fetch(`${BASE}/notes`)).json()).toEqual({ Notes: [{ NoteID: 'n1', Text: 'Call back' }] });
  });

  it('a create with one object still answers', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items`, put({ ItemID: 'i2', Name: 'Nut' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ItemID: 'i2', Name: 'Nut' });
  });
});

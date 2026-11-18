import { describe, expect, it, vi } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainRoute,
  type ResourceRules,
  type SampleObject,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const WRITE = /^INSERT INTO sample_objects /;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rates are keyed by a code the vendor forms; notes by an id it generates. */
const SEED: SampleSeed = {
  rates: {
    idField: 'Code',
    items: [
      { Code: 'OUTPUT', Name: 'Sales', Rate: 10 },
      { Code: 'INPUT', Name: 'Purchases', Rate: 10 },
    ],
  },
  notes: { idField: 'NoteID', items: [{ NoteID: 'n1', Text: 'a' }] },
};

const ROUTES: PlainRoute[] = [
  { method: 'PUT', path: '/rates', op: 'create', resource: 'rates', wrap: 'Rates', bodyKey: 'Rates' },
  { method: 'GET', path: '/rates/:id', op: 'get', resource: 'rates', wrap: 'Rates' },
  { method: 'PUT', path: '/notes', op: 'create', resource: 'notes', wrap: 'Notes', bodyKey: 'Notes' },
];

type NewId = (ctx: { objects: readonly SampleObject[]; parentId: string | undefined }) => string;

/** The next code after the ones already in the view, counting objects written earlier in the request. */
const nextCode: NewId = ({ objects }) =>
  `RATE${String(objects.filter((o) => String(o.Code).startsWith('RATE')).length + 1).padStart(3, '0')}`;

/** `newId` is the rule under test; it reaches plainDialect as given. */
function install(newId?: NewId) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const resources = newId ? { rates: { newId } as ResourceRules } : {};
  const sim = createSimulator({ seed: SEED, dialect: plainDialect({ base: '/api', routes: ROUTES, resources }), store });
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
const answered = async (res: Response, key: string) => ((await res.json()) as Record<string, SampleObject[]>)[key] ?? [];

describe('an id the dialect forms', () => {
  it('a create without an id takes the id newId returns', async () => {
    const { sim } = install(nextCode);
    const res = await sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }] }));
    expect(res.status).toBe(200);
    expect((await answered(res, 'Rates')).map((r) => r.Code)).toEqual(['RATE001']);
    const got = await sim.fetch(`${BASE}/rates/RATE001`);
    expect(got.status).toBe(200);
    expect((await answered(got, 'Rates'))[0]?.Name).toBe('Zero');
  });

  it('newId sees ids written earlier in the same request', async () => {
    const { sim } = install(nextCode);
    const res = await sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }, { Name: 'Export', Rate: 0 }] }));
    expect((await answered(res, 'Rates')).map((r) => r.Code)).toEqual(['RATE001', 'RATE002']);
  });

  it('a newId that returns an id in use is refused exists, and nothing is written', async () => {
    const { d1, sim } = install(() => 'OUTPUT');
    const err = await refusal(sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }] })));
    expect(err?.reason).toBe('exists');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a newId that throws, or returns no usable id, is refused computed, and nothing is written', async () => {
    const boom = new Error('no code left');
    const thrown = install(() => {
      throw boom;
    });
    const err = await refusal(thrown.sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }] })));
    expect(err?.reason).toBe('computed');
    expect(err?.cause).toBe(boom);
    expect(count(thrown.d1.statements, WRITE)).toBe(0);

    const empty = install(() => '');
    expect((await refusal(empty.sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }] }))))?.reason).toBe('computed');
    expect(count(empty.d1.statements, WRITE)).toBe(0);
  });

  it('a create that carries its id never calls newId', async () => {
    const newId = vi.fn(nextCode);
    const { sim } = install(newId);
    const res = await sim.fetch(`${BASE}/rates`, put({ Rates: [{ Code: 'RATE050', Name: 'Zero', Rate: 0 }] }));
    expect((await answered(res, 'Rates')).map((r) => r.Code)).toEqual(['RATE050']);
    expect(newId).not.toHaveBeenCalled();
  });

  it('a resource with no newId still gets a UUID', async () => {
    const { sim } = install(nextCode);
    const res = await sim.fetch(`${BASE}/notes`, put({ Notes: [{ Text: 'b' }] }));
    expect(String((await answered(res, 'Notes'))[0]?.NoteID)).toMatch(UUID);
  });
});

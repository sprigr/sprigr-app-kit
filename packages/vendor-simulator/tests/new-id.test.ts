import { describe, expect, it, vi } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type Dialect,
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

/** Rates are keyed by a code the vendor forms; tickets by a number it forms; notes by an id it generates. */
const SEED: SampleSeed = {
  rates: {
    idField: 'Code',
    items: [
      { Code: 'OUTPUT', Name: 'Sales', Rate: 10 },
      { Code: 'INPUT', Name: 'Purchases', Rate: 10 },
    ],
  },
  tickets: { idField: 'TicketID', items: [{ TicketID: 1041, Subject: 'a' }] },
  notes: { idField: 'NoteID', items: [{ NoteID: 'n1', Text: 'a' }] },
};

const ROUTES: PlainRoute[] = [
  { method: 'PUT', path: '/rates', op: 'create', resource: 'rates', wrap: 'Rates', bodyKey: 'Rates' },
  { method: 'GET', path: '/rates/:id', op: 'get', resource: 'rates', wrap: 'Rates' },
  { method: 'PUT', path: '/tickets', op: 'create', resource: 'tickets', wrap: 'Tickets', bodyKey: 'Tickets' },
  { method: 'GET', path: '/tickets/:id', op: 'get', resource: 'tickets', wrap: 'Tickets' },
  { method: 'PUT', path: '/notes', op: 'create', resource: 'notes', wrap: 'Notes', bodyKey: 'Notes' },
];

/** Returns unknown so a test can hand back a value the engine must refuse. */
type NewId = (ctx: { objects: readonly SampleObject[]; parentId: string | undefined }) => unknown;

/** The next code after the ones already in the view, counting objects written earlier in the request. */
const nextCode: NewId = ({ objects }) =>
  `RATE${String(objects.filter((o) => String(o.Code).startsWith('RATE')).length + 1).padStart(3, '0')}`;

/** The next ticket number after the highest in the view. */
const nextTicket: NewId = ({ objects }) => Math.max(...objects.map((o) => Number(o.TicketID))) + 1;

/**
 * `newId` is the rule under test, on `resource`; it reaches plainDialect as given.
 * Tickets have number ids and a create route, so they always get one, which a tickets row replaces.
 */
function install(newId?: NewId, resource = 'rates') {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const resources: Record<string, ResourceRules> = { tickets: { newId: nextTicket } as ResourceRules };
  if (newId) resources[resource] = { newId } as ResourceRules;
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

  it('a newId that returns a number answers a number id, and a get by it finds it', async () => {
    const { sim } = install(({ objects }) => Math.max(...objects.map((o) => Number(o.TicketID))) + 1, 'tickets');
    const res = await sim.fetch(`${BASE}/tickets`, put({ Tickets: [{ Subject: 'b' }] }));
    expect(res.status).toBe(200);
    expect((await answered(res, 'Tickets'))[0]?.TicketID).toBe(1042);
    const got = await sim.fetch(`${BASE}/tickets/1042`);
    expect(got.status).toBe(200);
    expect((await answered(got, 'Tickets'))[0]).toEqual({ TicketID: 1042, Subject: 'b' });
  });

  it('a newId that returns a number that is not finite is refused computed, and nothing is written', async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { d1, sim } = install(() => value, 'tickets');
      const err = await refusal(sim.fetch(`${BASE}/tickets`, put({ Tickets: [{ Subject: 'b' }] })));
      expect(err?.reason).toBe('computed');
      expect(count(d1.statements, WRITE)).toBe(0);
    }
  });

  it('a newId that returns undefined is refused computed, and nothing is written', async () => {
    const { d1, sim } = install(() => undefined);
    const err = await refusal(sim.fetch(`${BASE}/rates`, put({ Rates: [{ Name: 'Zero', Rate: 0 }] })));
    expect(err?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('a number id the app has not said how to form', () => {
  const getTicket: PlainRoute = { method: 'GET', path: '/tickets/:id', op: 'get', resource: 'tickets', wrap: 'Tickets' };
  const updateTicket: PlainRoute = { method: 'POST', path: '/tickets/:id', op: 'update', resource: 'tickets', wrap: 'Tickets', bodyKey: 'Tickets' };
  const createTicket: PlainRoute = { method: 'PUT', path: '/tickets', op: 'create', resource: 'tickets', wrap: 'Tickets', bodyKey: 'Tickets' };
  const upsertTicket: PlainRoute = { ...createTicket, method: 'POST', upsert: true };

  /** A simulator over tickets numbered from 1041, under the given dialect. */
  function build(dialect: Dialect) {
    const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
    const store = createSampleStore({ db: d1.db, table: TABLE });
    return createSimulator({ seed: { tickets: { idField: 'TicketID', items: [{ TicketID: 1041, Subject: 'a' }] } }, dialect, store });
  }

  it('a number-id resource with a create or upsert route and no newId throws at build, naming it', () => {
    for (const create of [createTicket, upsertTicket]) {
      const dialect = plainDialect({ base: '/api', routes: [getTicket, create] });
      expect(() => build(dialect)).toThrow(TypeError);
      expect(() => build(dialect)).toThrow(/"tickets"/);
    }
  });

  it('a number-id resource with a create route and a newId builds', () => {
    const dialect = plainDialect({ base: '/api', routes: [getTicket, createTicket], resources: { tickets: { newId: nextTicket } as ResourceRules } });
    expect(() => build(dialect)).not.toThrow();
  });

  it('a number-id resource with get and update routes only builds without a newId', () => {
    expect(() => build(plainDialect({ base: '/api', routes: [getTicket, updateTicket] }))).not.toThrow();
  });

  it('a dialect that declares no created resources builds, as before', () => {
    const dialect: Dialect = { ...plainDialect({ base: '/api', routes: [getTicket, createTicket] }), created: undefined };
    expect(() => build(dialect)).not.toThrow();
  });
});

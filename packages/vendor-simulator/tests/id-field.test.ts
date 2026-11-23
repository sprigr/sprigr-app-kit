import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
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
const WRITE = /^INSERT INTO sample_objects /;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SEED: SampleSeed = {
  contacts: { idField: 'ContactID', items: [{ ContactID: 'c1', Name: 'Ann' }] },
  tickets: { idField: 'TicketID', items: [{ TicketID: 1041, Subject: 'a' }] },
  projects: { idField: 'ProjectID', items: [{ ProjectID: 'p1', Name: 'Fitout' }] },
  tasks: { idField: 'TaskID', items: [{ TaskID: 't1', ProjectID: 'p1', Name: 'Measure' }] },
};

const parent = { param: 'projectId', resource: 'projects', field: 'ProjectID' };

const ROUTES: PlainRoute[] = [
  { method: 'PUT', path: '/contacts', op: 'create', resource: 'contacts', wrap: 'Contacts', bodyKey: 'Contacts' },
  { method: 'POST', path: '/contacts', op: 'create', resource: 'contacts', wrap: 'Contacts', bodyKey: 'Contacts', upsert: true },
  { method: 'GET', path: '/contacts/:id', op: 'get', resource: 'contacts', wrap: 'Contacts' },
  { method: 'POST', path: '/contacts/:id', op: 'update', resource: 'contacts', wrap: 'Contacts', bodyKey: 'Contacts' },
  { method: 'PUT', path: '/tickets', op: 'create', resource: 'tickets', wrap: 'Tickets', bodyKey: 'Tickets' },
  { method: 'GET', path: '/tickets/:id', op: 'get', resource: 'tickets', wrap: 'Tickets' },
  { method: 'POST', path: '/tickets/:id', op: 'update', resource: 'tickets', wrap: 'Tickets', bodyKey: 'Tickets' },
  { method: 'POST', path: '/projects/:projectId/tasks', op: 'create', resource: 'tasks', parent },
  { method: 'POST', path: '/projects/:projectId/tasks/:id', op: 'update', resource: 'tasks', parent },
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
/** A string body is sent as written, so a number JSON.stringify cannot form reaches the engine. */
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const answered = async (res: Response, key: string) => ((await res.json()) as Record<string, SampleObject[]>)[key] ?? [];

describe('a body id that is not a usable id', () => {
  it('a create whose id is true, an object or an array is refused id, and nothing is written', async () => {
    for (const value of [true, {}, []]) {
      const { d1, sim } = install();
      const err = await refusal(sim.fetch(`${BASE}/contacts`, send('PUT', { Contacts: [{ ContactID: value, Name: 'Bo' }] })));
      expect(err?.reason).toBe('id');
      expect(count(d1.statements, WRITE)).toBe(0);
    }
  });

  it('a create whose id is an empty string is refused id, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/contacts`, send('PUT', { Contacts: [{ ContactID: '', Name: 'Bo' }] })));
    expect(err?.reason).toBe('id');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a create whose id is a number too large for a double is refused id, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/tickets`, send('PUT', '{"Tickets":[{"TicketID":1e400,"Subject":"b"}]}')));
    expect(err?.reason).toBe('id');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a batch whose second object has an unusable id is refused whole, and nothing is written', async () => {
    const { d1, sim } = install();
    const batch = { Contacts: [{ ContactID: 'c9', Name: 'Bo' }, { ContactID: true, Name: 'Cy' }] };
    const err = await refusal(sim.fetch(`${BASE}/contacts`, send('PUT', batch)));
    expect(err?.reason).toBe('id');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('an upsert create whose id is true is refused id, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/contacts`, send('POST', { Contacts: [{ ContactID: true, Name: 'Bo' }] })));
    expect(err?.reason).toBe('id');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('a body parent field that matches the parent only as a string', () => {
  it('a child create whose parent field is an array of the parent id is refused parent, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/projects/p1/tasks`, send('POST', { TaskID: 't9', ProjectID: ['p1'], Name: 'Paint' })));
    expect(err?.reason).toBe('parent');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('an update whose parent field is an array of the parent id is refused parent, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/projects/p1/tasks/t1`, send('POST', { ProjectID: ['p1'], Name: 'Mark' })));
    expect(err?.reason).toBe('parent');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('usable ids keep working', () => {
  it('a create whose id is null or absent still gets a minted id', async () => {
    for (const contact of [{ ContactID: null, Name: 'Bo' }, { Name: 'Bo' }]) {
      const { sim } = install();
      const res = await sim.fetch(`${BASE}/contacts`, send('PUT', { Contacts: [contact] }));
      expect(res.status).toBe(200);
      expect(String((await answered(res, 'Contacts'))[0]?.ContactID)).toMatch(UUID);
    }
  });

  it('a given number id is answered as a number, and a given string id as a string', async () => {
    const { sim } = install();
    const ticket = await sim.fetch(`${BASE}/tickets`, send('PUT', { Tickets: [{ TicketID: 2000, Subject: 'b' }] }));
    expect((await answered(ticket, 'Tickets'))[0]?.TicketID).toBe(2000);
    expect((await answered(await sim.fetch(`${BASE}/tickets/2000`), 'Tickets'))[0]?.TicketID).toBe(2000);
    const contact = await sim.fetch(`${BASE}/contacts`, send('PUT', { Contacts: [{ ContactID: 'c9', Name: 'Bo' }] }));
    expect((await answered(contact, 'Contacts'))[0]?.ContactID).toBe('c9');
  });
});

describe('an update body id', () => {
  it('an update whose body names a different id is refused id, nothing is written, and neither id changes', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/contacts/c1`, send('POST', { Contacts: [{ ContactID: 'c2', Name: 'Bo' }] })));
    expect(err?.reason).toBe('id');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await answered(await sim.fetch(`${BASE}/contacts/c1`), 'Contacts')).toEqual([{ ContactID: 'c1', Name: 'Ann' }]);
    expect((await sim.fetch(`${BASE}/contacts/c2`)).status).toBe(404);
  });

  it('an update whose body id is true, an empty string or an object is refused id, and nothing is written', async () => {
    for (const value of [true, '', {}]) {
      const { d1, sim } = install();
      const err = await refusal(sim.fetch(`${BASE}/contacts/c1`, send('POST', { Contacts: [{ ContactID: value, Name: 'Bo' }] })));
      expect(err?.reason).toBe('id');
      expect(count(d1.statements, WRITE)).toBe(0);
      expect(await answered(await sim.fetch(`${BASE}/contacts/c1`), 'Contacts')).toEqual([{ ContactID: 'c1', Name: 'Ann' }]);
    }
  });

  it('an update whose body carries the object\'s own id still answers, as a string and as a number', async () => {
    const { sim } = install();
    const contact = await sim.fetch(`${BASE}/contacts/c1`, send('POST', { Contacts: [{ ContactID: 'c1', Name: 'Bo' }] }));
    expect(contact.status).toBe(200);
    expect(await answered(contact, 'Contacts')).toEqual([{ ContactID: 'c1', Name: 'Bo' }]);
    const ticket = await sim.fetch(`${BASE}/tickets/1041`, send('POST', { Tickets: [{ TicketID: 1041, Subject: 'b' }] }));
    expect(ticket.status).toBe(200);
    expect(await answered(ticket, 'Tickets')).toEqual([{ TicketID: 1041, Subject: 'b' }]);
  });

  it('an update whose body id is null is treated as absent and still answers', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/contacts/c1`, send('POST', { Contacts: [{ ContactID: null, Name: 'Bo' }] }));
    expect(res.status).toBe(200);
    expect(await answered(res, 'Contacts')).toEqual([{ ContactID: 'c1', Name: 'Bo' }]);
  });
});

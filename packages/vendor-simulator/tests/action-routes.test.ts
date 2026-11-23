import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type CompleteContext,
  type PlainRoute,
  type ResourceRules,
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
      { ItemID: 'i1', Name: 'Hook', Status: 'DRAFT', Sent: false },
      { ItemID: 'i2', Name: 'Line', Status: 'DRAFT', Sent: false },
    ],
  },
  projects: { idField: 'ProjectID', items: [{ ProjectID: 'pr1' }, { ProjectID: 'pr2' }] },
  tasks: {
    idField: 'TaskID',
    items: [
      { TaskID: 't1', ProjectID: 'pr1', Name: 'Measure', Status: 'OPEN' },
      { TaskID: 't2', ProjectID: 'pr2', Name: 'Strip', Status: 'OPEN' },
    ],
  },
};

const parent = { param: 'projectId', resource: 'projects', field: 'ProjectID' };

const ROUTES: PlainRoute[] = [
  { method: 'GET', path: '/items/:id', op: 'get', resource: 'items', wrap: 'Items' },
  { method: 'POST', path: '/items/:id/approve', op: 'action', resource: 'items', wrap: 'Items', action: 'approve', answer: 'object' },
  { method: 'POST', path: '/items/:id/email', op: 'action', resource: 'items', action: 'email', answer: 'empty' },
  { method: 'POST', path: '/items/:id/touch', op: 'action', resource: 'items', wrap: 'Items', action: 'touch', answer: 'object' },
  { method: 'POST', path: '/items/:id/boom', op: 'action', resource: 'items', action: 'boom', answer: 'object' },
  { method: 'POST', path: '/items/:id/drop', op: 'action', resource: 'items', action: 'drop', answer: 'object' },
  { method: 'GET', path: '/projects/:projectId/tasks/:id', op: 'get', resource: 'tasks', parent },
  { method: 'POST', path: '/projects/:projectId/tasks/:id/close', op: 'action', resource: 'tasks', parent, action: 'close', answer: 'object' },
  { method: 'POST', path: '/projects/:projectId/tasks/:id/move', op: 'action', resource: 'tasks', parent, action: 'move', answer: 'object' },
];

/** The rules an app would supply: each action changes what its vendor would change. */
function rules(calls: CompleteContext[] = []): Record<string, ResourceRules> {
  return {
    items: {
      computed: [],
      complete: (obj, ctx) => {
        calls.push(ctx);
        if (ctx.action === 'approve') return { ...obj, Status: 'AUTHORISED' };
        if (ctx.action === 'email') return { ...obj, Sent: true };
        if (ctx.action === 'boom') throw new Error('boom');
        if (ctx.action === 'drop') return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'Name'));
        return obj;
      },
    },
    tasks: {
      computed: [],
      complete: (obj, ctx) => {
        if (ctx.action === 'close') return { ...obj, Status: 'CLOSED' };
        if (ctx.action === 'move') return { ...obj, TaskID: 'zz', ProjectID: 'pr2', Status: 'MOVED' };
        return obj;
      },
    },
  };
}

/** Built per test, so a throwing build fails each row by name. */
function install(calls: CompleteContext[] = []) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const dialect = plainDialect({ base: '/api', routes: ROUTES, resources: rules(calls) });
  const sim = createSimulator({ seed: SEED, dialect, store });
  return { d1, sim };
}

const count = (statements: string[], re: RegExp) => statements.filter((s) => re.test(s)).length;
const POST = { method: 'POST' };

async function first(res: Response, key: string): Promise<SampleObject | undefined> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Record<string, SampleObject[]>)[key]?.[0];
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

describe('an action route', () => {
  it('passes the action to complete, stores the result and answers it', async () => {
    const calls: CompleteContext[] = [];
    const { d1, sim } = install(calls);
    const answered = await first(await sim.fetch(`${BASE}/items/i1/approve`, POST), 'Items');
    expect(answered).toEqual({ ItemID: 'i1', Name: 'Hook', Status: 'AUTHORISED', Sent: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('action');
    expect(calls[0]?.action).toBe('approve');
    expect(calls[0]?.previous).toEqual({ ItemID: 'i1', Name: 'Hook', Status: 'DRAFT', Sent: false });
    expect(count(d1.statements, WRITE)).toBe(1);
    expect(await first(await sim.fetch(`${BASE}/items/i1`), 'Items')).toEqual(answered);
  });

  it("answers 'empty' with 204 and no body, and stores the change", async () => {
    const { d1, sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1/email`, POST);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(count(d1.statements, WRITE)).toBe(1);
    expect((await first(await sim.fetch(`${BASE}/items/i1`), 'Items'))?.Sent).toBe(true);
  });

  it('answers an action that changes nothing and writes nothing', async () => {
    const { d1, sim } = install();
    const answered = await first(await sim.fetch(`${BASE}/items/i2/touch`, POST), 'Items');
    expect(answered).toEqual({ ItemID: 'i2', Name: 'Line', Status: 'DRAFT', Sent: false });
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('refuses any body, {} included, before reading the overlay', async () => {
    const { d1, sim } = install();
    const json = { 'content-type': 'application/json' };
    const sends: Array<Promise<Response>> = [
      sim.fetch(`${BASE}/items/i1/approve`, { method: 'POST', headers: json, body: '{}' }),
      sim.fetch(`${BASE}/items/i1/approve`, { method: 'POST', headers: json, body: JSON.stringify({ Status: 'VOID' }) }),
      sim.fetch(new Request(`${BASE}/items/i1/approve`, { method: 'POST', headers: json, body: '{}' })),
      sim.fetch(new Request(`${BASE}/items/i1/approve`, { method: 'POST', headers: json, body: JSON.stringify({ Status: 'VOID' }) })),
    ];
    for (const p of sends) expect((await refusal(p))?.reason).toBe('body');
    expect(count(d1.statements, OVERLAY_READ)).toBe(0);
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('answers a Content-Type header with an empty body', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/items/i1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect((await first(res, 'Items'))?.Status).toBe('AUTHORISED');
  });

  it('answers 404 for an unknown id and writes nothing', async () => {
    const { d1, sim } = install();
    expect((await sim.fetch(`${BASE}/items/nope/approve`, POST)).status).toBe(404);
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it("answers 404 for another parent's child and for a missing parent, and writes nothing", async () => {
    const { d1, sim } = install();
    expect((await sim.fetch(`${BASE}/projects/pr1/tasks/t2/close`, POST)).status).toBe(404);
    expect((await sim.fetch(`${BASE}/projects/nope/tasks/t1/close`, POST)).status).toBe(404);
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('refuses a throw from complete as computed, keeping the cause, and writes nothing', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/items/i1/boom`, POST));
    expect(err?.reason).toBe('computed');
    expect((err?.cause as Error | undefined)?.message).toBe('boom');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('puts back the id and the parent field complete changed', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/projects/pr1/tasks/t1/move`, POST);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ TaskID: 't1', ProjectID: 'pr1', Name: 'Measure', Status: 'MOVED' });
    const after = await sim.fetch(`${BASE}/projects/pr1/tasks/t1`);
    expect(((await after.json()) as SampleObject).Status).toBe('MOVED');
  });

  it('refuses a query parameter and a non-JSON Accept, without reading the overlay', async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items/i1/approve?x=1`, POST)))?.reason).toBe('query');
    const pdf = { method: 'POST', headers: { accept: 'application/pdf' } };
    expect((await refusal(sim.fetch(`${BASE}/items/i1/approve`, pdf)))?.reason).toBe('accept');
    expect(count(d1.statements, OVERLAY_READ)).toBe(0);
  });

  it('refuses a completed object missing a seed field as computed, and writes nothing', async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/items/i1/drop`, POST)))?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('an action route at build', () => {
  const valid: PlainRoute = { method: 'POST', path: '/items/:id/approve', op: 'action', resource: 'items', action: 'approve', answer: 'object' };
  const build = (route: PlainRoute, resources: Record<string, ResourceRules> = rules()) => () =>
    plainDialect({ base: '/api', routes: [route], resources });
  const throws = (fn: () => unknown, re: RegExp) => {
    expect(fn).toThrow(TypeError);
    expect(fn).toThrow(re);
  };

  it('throws for each route it cannot model, and builds a valid one', () => {
    throws(build({ ...valid, path: '/items/approve' }), /route names its object id :id/);
    throws(build({ ...valid, action: undefined }), /an action route needs an action name/);
    throws(build({ ...valid, action: '' }), /an action route needs an action name/);
    throws(build({ method: 'POST', path: '/items/:id', op: 'update', resource: 'items', action: 'approve' }), /action is for an action route/);
    throws(build({ ...valid, answer: undefined }), /an action route needs answer/);
    throws(build({ method: 'GET', path: '/items/:id', op: 'get', resource: 'items', answer: 'empty' }), /answer is for an action route/);
    throws(build(valid, { items: { computed: [] } }), /an action route on resource "items" needs complete/);
    expect(build(valid)).not.toThrow();
  });
});

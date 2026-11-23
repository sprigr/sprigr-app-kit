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

const SEED: SampleSeed = {
  projects: { idField: 'ProjectID', items: [{ ProjectID: 'p1', Name: 'Fitout' }, { ProjectID: 'p2', Name: 'Roof' }] },
  tasks: {
    idField: 'TaskID',
    items: [
      { TaskID: 't1', ProjectID: 'p1', Name: 'Measure' },
      { TaskID: 't2', ProjectID: 'p1', Name: 'Order' },
      { TaskID: 't3', ProjectID: 'p2', Name: 'Strip' },
    ],
  },
};

const parent = { param: 'projectId', resource: 'projects', field: 'ProjectID' };

/** Built per test, so a throwing build fails each row by name. */
const dialect = () =>
  plainDialect({
    base: '/api',
    routes: [
      { method: 'GET', path: '/projects/:id', op: 'get', resource: 'projects' },
      { method: 'DELETE', path: '/projects/:id', op: 'delete', resource: 'projects' },
      { method: 'GET', path: '/projects/:projectId/tasks', op: 'list', resource: 'tasks', parent },
      { method: 'GET', path: '/projects/:projectId/tasks/:id', op: 'get', resource: 'tasks', parent },
      { method: 'POST', path: '/projects/:projectId/tasks', op: 'create', resource: 'tasks', parent },
      { method: 'POST', path: '/projects/:projectId/tasks/:id', op: 'update', resource: 'tasks', parent },
      { method: 'DELETE', path: '/projects/:projectId/tasks/:id', op: 'delete', resource: 'tasks', parent },
    ],
  });

function install() {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: dialect(), store });
  return { d1, sim };
}

const count = (statements: string[], re: RegExp) => statements.filter((s) => re.test(s)).length;
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const taskIds = async (res: Response) => ((await res.json()) as Array<{ TaskID: string }>).map((t) => t.TaskID);

const build = (routes: PlainRoute[]) => () => plainDialect({ routes });

describe('a nested route must declare its parent', () => {
  it('a route with two path parameters and no parent throws at build', () => {
    expect(build([{ method: 'GET', path: '/projects/:projectId/tasks/:id', op: 'get', resource: 'tasks' }])).toThrow(TypeError);
    expect(build([{ method: 'GET', path: '/projects/:projectId/tasks', op: 'list', resource: 'tasks', parent: { ...parent, param: 'nope' } }])).toThrow(TypeError);
  });

  it('a get, update or delete route that does not name its id :id throws at build', () => {
    expect(build([{ method: 'GET', path: '/tasks/:taskId', op: 'get', resource: 'tasks' }])).toThrow(TypeError);
    expect(build([{ method: 'POST', path: '/projects/:projectId/tasks/:taskId', op: 'update', resource: 'tasks', parent }])).toThrow(TypeError);
    expect(build([{ method: 'DELETE', path: '/tasks', op: 'delete', resource: 'tasks' }])).toThrow(TypeError);
  });
});

describe('a declared parent scopes its children', () => {
  it('lists only the children of that parent', async () => {
    const { sim } = install();
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p1/tasks`))).toEqual(['t1', 't2']);
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p2/tasks`))).toEqual(['t3']);
  });

  it('gets a child through its own parent', async () => {
    const { sim } = install();
    expect(((await (await sim.fetch(`${BASE}/projects/p2/tasks/t3`)).json()) as { TaskID: string }).TaskID).toBe('t3');
  });

  it("another parent's child answers 404 for get, update and delete, and nothing is written", async () => {
    const { d1, sim } = install();
    expect((await sim.fetch(`${BASE}/projects/p1/tasks/t3`)).status).toBe(404);
    expect((await sim.fetch(`${BASE}/projects/p1/tasks/t3`, post({ Name: 'Moved' }))).status).toBe(404);
    expect((await sim.fetch(`${BASE}/projects/p1/tasks/t3`, { method: 'DELETE' })).status).toBe(404);
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a create under a parent stores the parent id from the path', async () => {
    const { sim } = install();
    const created = (await (await sim.fetch(`${BASE}/projects/p1/tasks`, post({ Name: 'Fit' }))).json()) as { TaskID: string; ProjectID: string };
    expect(created.ProjectID).toBe('p1');
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p1/tasks`))).toContain(created.TaskID);
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p2/tasks`))).not.toContain(created.TaskID);
  });

  it('a create whose body names a different parent is refused and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await sim.fetch(`${BASE}/projects/p1/tasks`, post({ Name: 'Fit', ProjectID: 'p2' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotSimulatedError);
    expect((err as NotSimulatedError).reason).toBe('parent');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it("a create carrying the id of another parent's child is refused, alone or in a batch, and nothing is written", async () => {
    const { d1, sim } = install();
    for (const body of [{ TaskID: 't3', Name: 'Taken' }, [{ Name: 'New' }, { TaskID: 't3', Name: 'Taken' }]]) {
      const err = await sim.fetch(`${BASE}/projects/p1/tasks`, post(body)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotSimulatedError);
      expect((err as NotSimulatedError).reason).toBe('parent');
    }
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p2/tasks`))).toEqual(['t3']);
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p1/tasks`))).toEqual(['t1', 't2']);
  });

  it('an update cannot move a child to another parent', async () => {
    const { d1, sim } = install();
    const err = await sim.fetch(`${BASE}/projects/p1/tasks/t1`, post({ ProjectID: 'p2' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotSimulatedError);
    expect((err as NotSimulatedError).reason).toBe('parent');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a parent that does not exist answers 404 for a list and a create', async () => {
    const { d1, sim } = install();
    expect((await sim.fetch(`${BASE}/projects/nope/tasks`)).status).toBe(404);
    expect((await sim.fetch(`${BASE}/projects/nope/tasks`, post({ Name: 'Fit' }))).status).toBe(404);
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a parent deleted after its children answers 404 for them', async () => {
    const { sim } = install();
    for (const t of ['t1', 't2']) expect((await sim.fetch(`${BASE}/projects/p1/tasks/${t}`, { method: 'DELETE' })).status).toBe(204);
    expect((await sim.fetch(`${BASE}/projects/p1`, { method: 'DELETE' })).status).toBe(204);
    expect((await sim.fetch(`${BASE}/projects/p1/tasks`)).status).toBe(404);
    expect((await sim.fetch(`${BASE}/projects/p1/tasks/t1`)).status).toBe(404);
  });
});

describe('a parent that still has children', () => {
  const refusal = (p: Promise<Response>) =>
    p.then(
      () => null,
      (e: unknown) => {
        if (e instanceof NotSimulatedError) return e;
        throw e;
      },
    );

  it('cannot be deleted: the delete is refused children, nothing is written, and the parent still answers', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/projects/p1`, { method: 'DELETE' }));
    expect(err?.reason).toBe('children');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect((await sim.fetch(`${BASE}/projects/p1`)).status).toBe(200);
    expect(await taskIds(await sim.fetch(`${BASE}/projects/p1/tasks`))).toEqual(['t1', 't2']);
  });

  it('a child created in sample mode blocks the delete too', async () => {
    const { d1, sim } = install();
    expect((await sim.fetch(`${BASE}/projects/p2/tasks/t3`, { method: 'DELETE' })).status).toBe(204);
    expect((await sim.fetch(`${BASE}/projects/p2/tasks`, post({ Name: 'Patch' }))).status).toBe(200);
    const writes = count(d1.statements, WRITE);
    const err = await refusal(sim.fetch(`${BASE}/projects/p2`, { method: 'DELETE' }));
    expect(err?.reason).toBe('children');
    expect(count(d1.statements, WRITE)).toBe(writes);
    expect((await sim.fetch(`${BASE}/projects/p2`)).status).toBe(200);
  });
});

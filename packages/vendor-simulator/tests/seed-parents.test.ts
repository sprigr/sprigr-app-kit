import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type Dialect,
  type SampleObject,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';

const parent = { param: 'projectId', resource: 'projects', field: 'ProjectID' };
const projectsDialect = () =>
  plainDialect({
    base: '/api',
    routes: [
      { method: 'GET', path: '/projects/:id', op: 'get', resource: 'projects' },
      { method: 'GET', path: '/projects/:projectId/tasks', op: 'list', resource: 'tasks', parent },
    ],
  });

/** A simulator over projects p1 and p2 and the given tasks, under the given dialect. */
function simulatorOf(tasks: SampleObject[], dialect: Dialect = projectsDialect()) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const seed = {
    projects: { idField: 'ProjectID', items: [{ ProjectID: 'p1', Name: 'Fitout' }, { ProjectID: 'p2', Name: 'Roof' }] },
    tasks: { idField: 'TaskID', items: tasks },
  };
  return createSimulator({ seed, dialect, store });
}

describe('a seed child must name a seed parent', () => {
  it('a seed child naming a parent the seed does not have throws at build, naming the resource', () => {
    const tasks = [{ TaskID: 't1', ProjectID: 'p1', Name: 'Measure' }, { TaskID: 't2', ProjectID: 'p9', Name: 'Order' }];
    expect(() => simulatorOf(tasks)).toThrow(TypeError);
    expect(() => simulatorOf(tasks)).toThrow(/"tasks"/);
  });

  it('a seed child whose parent field is not a usable id throws at build', () => {
    for (const value of [['p1'], true, '']) {
      expect(() => simulatorOf([{ TaskID: 't1', ProjectID: value, Name: 'Measure' }])).toThrow(TypeError);
    }
  });

  it('a seed whose children all name seed parents builds', () => {
    const tasks = [{ TaskID: 't1', ProjectID: 'p1', Name: 'Measure' }, { TaskID: 't2', ProjectID: 'p2', Name: 'Strip' }];
    expect(() => simulatorOf(tasks)).not.toThrow();
  });

  it('a seed child with no parent field builds', () => {
    expect(() => simulatorOf([{ TaskID: 't1', Name: 'Loose' }])).not.toThrow();
  });

  it('a dialect that declares no parents builds, as before', () => {
    const dialect: Dialect = { ...projectsDialect(), parents: undefined };
    expect(() => simulatorOf([{ TaskID: 't1', ProjectID: 'p9', Name: 'Order' }], dialect)).not.toThrow();
  });
});

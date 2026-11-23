import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type SampleObject,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';

/** A simulator over one resource, `contacts`, keyed by `ContactID`, with a get route. */
function simulatorOf(items: SampleObject[]) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const dialect = plainDialect({ base: '/api', routes: [{ method: 'GET', path: '/contacts/:id', op: 'get', resource: 'contacts' }] });
  return createSimulator({ seed: { contacts: { idField: 'ContactID', items } }, dialect, store });
}

/** A build that throws a TypeError naming the resource. */
const throwsForContacts = (items: SampleObject[]) => expect(() => simulatorOf(items)).toThrow(/"contacts"/);
const isTypeError = (items: SampleObject[]) => expect(() => simulatorOf(items)).toThrow(TypeError);

describe('seed ids are checked at build', () => {
  it('a seed object with no id, or a null id, throws at build', () => {
    for (const items of [[{ Name: 'Ann' }], [{ ContactID: null, Name: 'Ann' }]]) {
      isTypeError(items);
      throwsForContacts(items);
    }
  });

  it('a seed object whose id is not a usable id throws at build', () => {
    for (const id of ['', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      const items = [{ ContactID: 'c1', Name: 'Ann' }, { ContactID: id, Name: 'Bo' }];
      isTypeError(items);
      throwsForContacts(items);
    }
  });

  it('two seed objects with the same id, compared as strings, throw at build', () => {
    for (const [a, b] of [['c1', 'c1'], [5, '5']]) {
      const items = [{ ContactID: a, Name: 'Ann' }, { ContactID: b, Name: 'Bo' }];
      isTypeError(items);
      throwsForContacts(items);
    }
  });

  it('unique string and number seed ids build, and a get by each finds its object', async () => {
    const sim = simulatorOf([{ ContactID: 'c1', Name: 'Ann' }, { ContactID: 7, Name: 'Bo' }]);
    const ann = await sim.fetch(`${BASE}/contacts/c1`);
    expect(ann.status).toBe(200);
    expect(await ann.json()).toEqual({ ContactID: 'c1', Name: 'Ann' });
    const bo = await sim.fetch(`${BASE}/contacts/7`);
    expect(bo.status).toBe(200);
    expect(await bo.json()).toEqual({ ContactID: 7, Name: 'Bo' });
  });
});

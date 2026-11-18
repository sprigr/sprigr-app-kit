import { describe, expect, it, vi } from 'vitest';
import {
  createSampleStore,
  createSampleSwitch,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  sampleAwareFetch,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainDialectOptions,
  type PlainRoute,
  type ResourceRules,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const WRITE = /^INSERT INTO sample_objects /;

const SEED: SampleSeed = {
  contacts: {
    idField: 'ContactID',
    items: [
      { ContactID: 'c1', Name: 'Ash' },
      { ContactID: 'c2', Name: 'Birch' },
    ],
  },
  settings: { idField: 'SettingID', items: [{ SettingID: 's1', Name: 'Default' }] },
  claims: { idField: 'ClaimID', items: [{ ClaimID: 'cl1', Status: 'SUBMITTED' }] },
};

const getContact: PlainRoute = { method: 'GET', path: '/contacts/:id', op: 'get', resource: 'contacts', wrap: 'Contacts' };
const listSettings: PlainRoute = { method: 'GET', path: '/contacts/settings', op: 'list', resource: 'settings', wrap: 'Settings' };
const updateContact: PlainRoute = {
  method: 'POST', path: '/contacts/:id', op: 'update', resource: 'contacts', wrap: 'Contacts', bodyKey: 'Contacts',
};
const approveClaim: PlainRoute = {
  method: 'POST', path: '/claims/:id/approve', op: 'action', resource: 'claims', wrap: 'Claims', action: 'approve', answer: 'object',
};
const resources: Record<string, ResourceRules> = {
  claims: { complete: (obj) => ({ ...obj, Status: 'APPROVED' }) },
};

/** `reserved` is the option under test; it reaches plainDialect as given. */
const build = (routes: PlainRoute[], reserved?: string[]) =>
  plainDialect({ base: '/api', routes, resources, ...(reserved ? { reserved } : {}) } as PlainDialectOptions);

/** One install with the sample flag on, answering through the dialect given. */
function install(routes: PlainRoute[], reserved?: string[]) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed: SEED, dialect: build(routes, reserved), store });
  return { d1, store, sim };
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
const post = (body?: unknown) => ({
  method: 'POST',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const listed = async (res: Response, key: string, idField: string) =>
  ((await res.json()) as Record<string, Array<Record<string, unknown>>>)[key]?.map((o) => o[idField]);

describe('a literal segment is never taken by a parameter', () => {
  it('a literal route beats a parameter route declared before it', async () => {
    const { sim } = install([getContact, listSettings]);
    const res = await sim.fetch(`${BASE}/contacts/settings`);
    expect(res.status).toBe(200);
    expect(await listed(res, 'Settings', 'SettingID')).toEqual(['s1']);
  });

  it('a parameter route still answers an id that is not a literal', async () => {
    const { sim } = install([getContact, listSettings]);
    const res = await sim.fetch(`${BASE}/contacts/c1`);
    expect(res.status).toBe(200);
    expect(await listed(res, 'Contacts', 'ContactID')).toEqual(['c1']);
  });

  it('a literal path routed for one method is refused for another, not taken by the parameter route', async () => {
    const { d1, store, sim } = install([listSettings, updateContact]);
    const network = vi.fn(async () => new Response('network'));
    const fetchImpl = sampleAwareFetch({ sampleSwitch: createSampleSwitch(store), simulator: sim, network });
    const err = await refusal(fetchImpl(`${BASE}/contacts/settings`, post({ Contacts: [{ Name: 'Cedar' }] })));
    expect(err?.reason).toBe('no_route');
    expect(err?.method).toBe('POST');
    expect(count(d1.statements, WRITE)).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it('a literal is compared after decoding, so an encoded literal is not taken by a parameter', async () => {
    const { sim } = install([getContact, listSettings]);
    const res = await sim.fetch(`${BASE}/contacts/setting%73`);
    expect(res.status).toBe(200);
    expect(await listed(res, 'Settings', 'SettingID')).toEqual(['s1']);
  });
});

describe('a reserved vendor path', () => {
  it('a reserved path is refused as no_route, naming method and path, before any store read', async () => {
    const { d1, sim } = install([getContact], ['/contacts/settings']);
    const err = await refusal(sim.fetch(`${BASE}/contacts/settings`));
    expect(err).toBeInstanceOf(NotSimulatedError);
    expect(err?.reason).toBe('no_route');
    expect(err?.method).toBe('GET');
    expect(err?.path).toBe('/api/contacts/settings');
    expect(d1.statements).toEqual([]);
  });

  it('a reserved pattern with a parameter is refused for every value, and the action never runs', async () => {
    const { d1, sim } = install([approveClaim], ['/claims/users/:userId']);
    const err = await refusal(sim.fetch(`${BASE}/claims/users/approve`, post()));
    expect(err?.reason).toBe('no_route');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a path a reserved pattern does not match still reaches its route', async () => {
    const { sim } = install([getContact], ['/contacts/settings']);
    expect((await sim.fetch(`${BASE}/contacts/settings2`)).status).toBe(404);
    const res = await sim.fetch(`${BASE}/contacts/c1`);
    expect(res.status).toBe(200);
    expect(await listed(res, 'Contacts', 'ContactID')).toEqual(['c1']);
  });
});

describe('literal segments at build', () => {
  const throws = (fn: () => unknown, re: RegExp) => {
    expect(fn).toThrow(TypeError);
    expect(fn).toThrow(re);
  };

  it('build throws when a reserved path is also a route', () => {
    throws(() => build([listSettings], ['/contacts/settings']), /reserved path \/contacts\/settings is also a route/);
    throws(() => build([approveClaim], ['/claims/:claimId/approve']), /reserved path \/claims\/:claimId\/approve is also a route/);
    expect(() => build([getContact], ['/contacts/settings'])).not.toThrow();
  });

  it('build throws on two routes with the same method and path shape', () => {
    throws(
      () => build([getContact, { ...getContact, wrap: 'Other' }]),
      /routes GET \/contacts\/:id and GET \/contacts\/:id match the same requests/,
    );
    expect(() => build([getContact, updateContact, listSettings])).not.toThrow();
  });

  it('build throws on a reserved path that does not start with a slash or repeats a parameter name', () => {
    throws(() => build([getContact], ['contacts/settings']), /reserved path contacts\/settings must start with \//);
    throws(() => build([getContact], ['/claims/:a/:a']), /reserved path \/claims\/:a\/:a repeats a parameter/);
    expect(() => build([getContact], ['/claims/users/:userId'])).not.toThrow();
  });
});

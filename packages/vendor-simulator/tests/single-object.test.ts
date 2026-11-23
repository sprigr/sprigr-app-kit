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

/** One settings object, two payslips, and two folders of which one is the inbox. */
const SEED: SampleSeed = {
  settings: { idField: 'SettingsID', items: [{ SettingsID: 's1', Currency: 'AUD' }] },
  payslips: {
    idField: 'PayslipID',
    items: [
      { PayslipID: 'ps1', Net: 100 },
      { PayslipID: 'ps2', Net: 200 },
    ],
  },
  folders: {
    idField: 'FolderID',
    items: [
      { FolderID: 'f1', Name: 'Inbox', IsInbox: true },
      { FolderID: 'f2', Name: 'Sent', IsInbox: false },
    ],
  },
};

const settings: PlainRoute = { method: 'GET', path: '/settings', op: 'get', resource: 'settings', wrap: 'Settings', single: true };
const payslip: PlainRoute = { method: 'GET', path: '/payslips/:id', op: 'get', resource: 'payslips', wrap: 'Payslip', single: true };
const inbox: PlainRoute = { method: 'GET', path: '/folders/inbox', op: 'get', resource: 'folders', wrap: 'Folder', single: { pick: 'IsInbox' } };

function build(routes: PlainRoute[], seed: SampleSeed = SEED) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const sim = createSimulator({ seed, dialect: plainDialect({ base: '/api', routes }), store });
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
const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a single-object route', () => {
  it('an id-less single get answers the only object under wrap as an object', async () => {
    const { sim } = build([settings]);
    const res = await sim.fetch(`${BASE}/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Settings: { SettingsID: 's1', Currency: 'AUD' } });
  });

  it('a single get by id answers the object under wrap as an object, and 404 for an unknown id', async () => {
    const { sim } = build([payslip]);
    const res = await sim.fetch(`${BASE}/payslips/ps2`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Payslip: { PayslipID: 'ps2', Net: 200 } });
    expect((await sim.fetch(`${BASE}/payslips/ps9`)).status).toBe(404);
  });

  it('a get by id without single still answers a one-object array under wrap', async () => {
    const { sim } = build([{ ...payslip, single: undefined }]);
    expect(await (await sim.fetch(`${BASE}/payslips/ps1`)).json()).toEqual({ Payslip: [{ PayslipID: 'ps1', Net: 100 }] });
  });

  it('an update on a single route answers the object under wrap as an object, and stores it', async () => {
    const update: PlainRoute = { method: 'POST', path: '/payslips/:id', op: 'update', resource: 'payslips', wrap: 'Payslip', bodyKey: 'Payslip', single: true };
    const { sim } = build([payslip, update]);
    const res = await sim.fetch(`${BASE}/payslips/ps1`, send('POST', { Payslip: { Net: 150 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Payslip: { PayslipID: 'ps1', Net: 150 } });
    expect(await (await sim.fetch(`${BASE}/payslips/ps1`)).json()).toEqual({ Payslip: { PayslipID: 'ps1', Net: 150 } });
  });

  it('a single get with pick answers the one object whose pick field is true', async () => {
    const { sim } = build([inbox]);
    const res = await sim.fetch(`${BASE}/folders/inbox`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Folder: { FolderID: 'f1', Name: 'Inbox', IsInbox: true } });
  });

  it('an id-less single get whose view no longer holds exactly one object is refused computed, and nothing is written', async () => {
    const gone = build([settings, { method: 'DELETE', path: '/settings/:id', op: 'delete', resource: 'settings' }]);
    expect((await gone.sim.fetch(`${BASE}/settings/s1`, { method: 'DELETE' })).status).toBe(204);
    const before = count(gone.d1.statements, WRITE);
    expect((await refusal(gone.sim.fetch(`${BASE}/settings`)))?.reason).toBe('computed');
    expect(count(gone.d1.statements, WRITE)).toBe(before);

    const two = build([inbox, { method: 'POST', path: '/folders/:id', op: 'update', resource: 'folders' }]);
    expect((await two.sim.fetch(`${BASE}/folders/f2`, send('POST', { IsInbox: true }))).status).toBe(200);
    expect((await refusal(two.sim.fetch(`${BASE}/folders/inbox`)))?.reason).toBe('computed');
  });

  it('a write to an id-less single path is not routed', async () => {
    const { d1, sim } = build([settings]);
    expect((await refusal(sim.fetch(`${BASE}/settings`, send('POST', { Currency: 'NZD' }))))?.reason).toBe('no_route');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('a single-object route is checked at build', () => {
  it('an id-less single on a resource with two seed objects and no pick throws at build, naming it', () => {
    const route: PlainRoute = { method: 'GET', path: '/payslips', op: 'get', resource: 'payslips', wrap: 'Payslip', single: true };
    expect(() => build([route])).toThrow(TypeError);
    expect(() => build([route])).toThrow(/"payslips"/);
  });

  it('a pick that matches no seed object, or two, throws at build, naming the resource', () => {
    for (const flags of [[false, false], [true, true]]) {
      const folders = { idField: 'FolderID', items: flags.map((IsInbox, i) => ({ FolderID: `f${i + 1}`, IsInbox })) };
      expect(() => build([inbox], { ...SEED, folders })).toThrow(TypeError);
      expect(() => build([inbox], { ...SEED, folders })).toThrow(/"folders"/);
    }
  });

  it('single on a list, create, delete or action route throws at build', () => {
    const routes: PlainRoute[] = [
      { method: 'GET', path: '/payslips', op: 'list', resource: 'payslips', single: true },
      { method: 'PUT', path: '/payslips', op: 'create', resource: 'payslips', single: true },
      { method: 'DELETE', path: '/payslips/:id', op: 'delete', resource: 'payslips', single: true },
      { method: 'POST', path: '/payslips/:id/void', op: 'action', resource: 'payslips', action: 'void', single: true },
    ];
    for (const route of routes) expect(() => build([route])).toThrow(/single is for a get or update route/);
  });

  it('pick on a route that names :id throws at build', () => {
    const route: PlainRoute = { method: 'GET', path: '/folders/:id', op: 'get', resource: 'folders', single: { pick: 'IsInbox' } };
    expect(() => build([route])).toThrow(/pick is for a get route without :id/);
  });

  it('an update with single that leaves out :id throws at build, as without single', () => {
    const route: PlainRoute = { method: 'POST', path: '/settings', op: 'update', resource: 'settings', single: true };
    expect(() => build([route])).toThrow(/:id/);
  });
});

/**
 * `@sprigr/apps-home/testing`: fakeHome runs the real homeTool the way the
 * platform does and checks every answer with the platform's rules;
 * fakeSprigrData is a read-only env.SPRIGR.data.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, homeRequestProblems, homeTool, queue, schedule, type HomeFixtureCase, type HomeResult } from '../src/index';
import { FAKE_HOME_VIEWER, fakeHome, fakeSprigrData } from '../src/testing';

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'home-contracts', name), 'utf8')) as unknown;
}
const simpro = load('simpro.manifest.json');
const FILES: Record<string, unknown> = {
  'home/fixtures/my_day.json': load('simpro-my-day.fixtures.json'),
  'home/fixtures/crew_day.json': load('simpro-crew-day.fixtures.json'),
  'home/fixtures/new_enquiries.json': load('simpro-new-enquiries.fixtures.json'),
};
const readFile = (p: string) => (p in FILES ? JSON.stringify(FILES[p]) : undefined);

/** An app that answers every fixture case with exactly what the case expects: what a correct app does. */
type CaseEnv = { answer: HomeResult<never> };
const faithful = homeTool<CaseEnv>({
  my_day: schedule(async (env) => env.answer),
  crew_day: schedule(async (env) => env.answer),
  new_enquiries: queue(async (env) => env.answer),
});

describe('fakeHome', () => {
  it('builds requests the platform would send, with the local-midnight window', () => {
    const h = fakeHome(simpro);
    const req = h.request('my_day');
    expect(homeRequestProblems(req)).toEqual([]);
    expect(req).toMatchObject({
      contract: 'sprigr/home_schedule', version: '1.0.0', provider: 'my_day', scope: 'me', purpose: 'read', deadline_ms: 3500,
      basis: { day: '2026-10-07', tz: 'Australia/Brisbane', window_start: '2026-10-06T14:00:00Z', window_end: '2026-10-07T14:00:00Z' },
      person: { vendor_person_id: 'person_1', method: 'native' },
    });
    expect(h.request('crew_day').person).toBeUndefined();
    expect(h.request('whoami')).toMatchObject({ contract: 'sprigr/home_identity', scope: 'me', purpose: 'identity' });
  });

  it('builds a 23-hour window on the day Sydney starts daylight saving', () => {
    const req = fakeHome(simpro).request('my_day', { day: '2026-10-04', tz: 'Australia/Sydney' });
    expect(req.basis).toMatchObject({ window_start: '2026-10-03T14:00:00Z', window_end: '2026-10-04T13:00:00Z' });
  });

  it('runs every fixture case through the real tool, and a faithful app matches every expect with no problems', async () => {
    const h = fakeHome(simpro, { readFile });
    const runs = await h.runFixtures(faithful, { env: (c: HomeFixtureCase) => ({ answer: c.expect as HomeResult<never> }) });
    expect(runs.length).toBeGreaterThanOrEqual(6);
    for (const r of runs) {
      expect(r.problems, `${r.provider} / ${r.case}`).toEqual([]);
      expect(r.dropped, `${r.provider} / ${r.case}`).toEqual([]);
      expect(r.matchesExpect, `${r.provider} / ${r.case}: ${r.expectDiff.join(', ')}`).toBe(true);
    }
    expect(h.calls).toHaveLength(runs.length);
  });

  it('reports the records the platform would drop, and the difference from expect', async () => {
    const h = fakeHome(simpro, { readFile });
    const wrongLink = homeTool<CaseEnv>({
      my_day: schedule(async (env, _actor, req) => {
        const ok = env.answer;
        if (ok.state !== 'ok') return ok;
        const recs = (ok.records as Array<{ ref: { link?: string } }>).map((r) => ({ ...r, ref: { ...r.ref, link: 'invoice' } }));
        return home.ok(req, { as_of: ok.as_of, records: recs as never[] });
      }),
      crew_day: schedule(async (env) => env.answer),
      new_enquiries: queue(async (env) => env.answer),
    });
    const runs = await h.runFixtures(wrongLink, { env: (c) => ({ answer: c.expect as HomeResult<never> }) });
    const normal = runs.find((r) => r.provider === 'my_day' && r.case === 'a normal day')!;
    expect(normal.dropped.length).toBeGreaterThan(0);
    expect(normal.dropped[0]!.problems.join(' ')).toMatch(/link/);
    expect(normal.matchesExpect).toBe(false);
    expect(normal.expectDiff).toEqual(['records']);
  });

  it('stamps the viewer on a person provider, and shows the refusal when there is none', async () => {
    const h = fakeHome(simpro);
    const seen: unknown[] = [];
    const tool = homeTool<object>({ my_day: schedule(async (_env, actor, req) => { seen.push(actor); return home.empty(req); }) });
    expect((await h.call(tool, 'my_day', { env: {} })).problems).toEqual([]);
    expect(seen).toEqual([FAKE_HOME_VIEWER]);
    const refused = await h.call(tool, 'my_day', { env: {}, actor: null });
    expect(refused.answer).toBeNull();
    expect(refused.problems.join(' ')).toMatch(/no_caller_identity/);
  });

  it('refuses a manifest whose home block the platform would refuse, naming why', () => {
    const bad = JSON.parse(JSON.stringify(simpro)) as { home: { tool: string } };
    bad.home.tool = 'get_something_else_home';
    expect(() => fakeHome(bad)).toThrow(/fakeHome: .*get_simpro_home/);
    expect(() => fakeHome({ metadata: { slug: 'x' } })).toThrow(/no home block/);
  });

  it('needs readFile to run fixtures, and an unknown provider is named', async () => {
    const h = fakeHome(simpro);
    await expect(h.runFixtures(faithful, { env: () => ({ answer: home.empty(h.request('my_day')) }) })).rejects.toThrow(/readFile/);
    expect(() => h.request('nope')).toThrow(/no provider nope/);
  });
});

describe('fakeSprigrData', () => {
  const rows = [
    { objectID: 'inv-1', _tenant_id: 't1', status: 'AUTHORISED', amountDue: 10, dueDate: '2026-10-01' },
    { objectID: 'inv-2', _tenant_id: 't1', status: 'PAID', amountDue: 0, dueDate: '2026-09-01' },
    { objectID: 'inv-3', _tenant_id: 't2', status: 'AUTHORISED', amountDue: 5, dueDate: '2026-10-03' },
  ];

  it('searches with field filters, sorts, pages and trims attributes', async () => {
    const data = fakeSprigrData(rows);
    const res = await data.search({ filters: '_tenant_id:t1,status:AUTHORISED' });
    expect(res.hits.map((h) => h.objectID)).toEqual(['inv-1']);
    const sorted = await data.search({ sortBy: 'dueDate:desc', hitsPerPage: 2, attributesToRetrieve: ['dueDate'] });
    expect(sorted).toMatchObject({ nbHits: 3, page: 0, hits: [{ objectID: 'inv-3', dueDate: '2026-10-03' }, { objectID: 'inv-1', dueDate: '2026-10-01' }] });
    expect(sorted.hits[0]).not.toHaveProperty('amountDue');
    expect((await data.search({ page: 1, hitsPerPage: 2 })).hits).toHaveLength(1);
    expect(data.reads.map((r) => r.method)).toEqual(['search', 'search', 'search']);
  });

  it('gets by id and lists ids by prefix', async () => {
    const data = fakeSprigrData(rows);
    expect((await data.get('inv-2')).object).toMatchObject({ status: 'PAID' });
    expect((await data.get('missing')).object).toBeNull();
    expect((await data.listIds('inv-')).objectIDs).toEqual(['inv-1', 'inv-2', 'inv-3']);
  });

  it('refuses every write as a Home dispatch does, and records it', async () => {
    const data = fakeSprigrData(rows);
    await expect(data.import([{ objectID: 'x' }])).rejects.toMatchObject({ code: 'home_read_only' });
    await expect(data.partialUpdate([])).rejects.toMatchObject({ code: 'home_read_only' });
    await expect(data.delete(['x'])).rejects.toMatchObject({ code: 'home_read_only' });
    expect(data.refusedWrites).toEqual(['import', 'partialUpdate', 'delete']);
  });

  it('with named indexes, requires a declared index as the platform does', async () => {
    const data = fakeSprigrData({ invoices: rows });
    expect((await data.search({ index: 'invoices' })).nbHits).toBe(3);
    await expect(data.search()).rejects.toThrow(/unknown_data_index/);
    await expect(data.search({ index: 'contacts' })).rejects.toThrow(/unknown_data_index: contacts/);
  });
});

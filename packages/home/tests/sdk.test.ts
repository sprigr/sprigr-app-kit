/**
 * The Home SDK (FINAL-APP-FEEDS section 12): homeTool's routing, the person
 * rule, error mapping, the shaping the platform expects (basis echo, `v`,
 * records only when ok, the cap), checkAnswers, and the answer helpers.
 */

import { describe, it, expect } from 'vitest';
import { NotConnectedError } from '@sprigr/apps-app-sdk';
import {
  answerVersion,
  home,
  homeTool,
  identity,
  metrics,
  queue,
  schedule,
  type HomeRequest,
  type ScheduleRecord,
} from '../src/index';

const REQ: HomeRequest = {
  contract: 'sprigr/home_schedule',
  version: '1.0.0',
  provider: 'my_day',
  scope: 'me',
  basis: { day: '2026-10-07', tz: 'Australia/Brisbane', window_start: '2026-10-06T14:00:00Z', window_end: '2026-10-07T14:00:00Z' },
  person: { vendor_person_id: '7', method: 'native' },
  purpose: 'read',
  deadline_ms: 3500,
};
const PERSON = { platformUserId: 'usr_viewer' };

function block(id: string, i = 0): ScheduleRecord {
  return {
    id: `b-${i}`, kind: 'block', start: '2026-10-06T23:30:00Z', end: '2026-10-07T01:00:00Z',
    status: 'scheduled', category: 'job', title: `Job ${id}`, ref: { id },
  };
}

type Env = { seen?: unknown[] };

describe('homeTool routing and the person rule', () => {
  const tool = homeTool<Env>({
    my_day: schedule(async (env, actor, req) => {
      env.seen?.push(actor);
      return home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [block('1182')] });
    }),
    company_money: metrics(async (_env, req) => home.empty(req), { audience: 'company' }),
  });

  it('answers a Home dispatch for a person as { ok: true, result }, with basis and v set', async () => {
    const env: Env = { seen: [] };
    const out = await tool({ provider: 'my_day', _home: REQ, actor: PERSON }, env);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({ v: '1.0.0', state: 'ok', basis: { day: '2026-10-07', tz: 'Australia/Brisbane' } });
    expect(out.result.records).toHaveLength(1);
    expect(env.seen).toEqual([{ platformUserId: 'usr_viewer' }]);
  });

  it('refuses a person provider with no actor, or an agent-only actor, as no_caller_identity', async () => {
    for (const actor of [undefined, { agentId: 'agt_1' }, { role: 'owner' }]) {
      const out = await tool({ provider: 'my_day', _home: REQ, ...(actor ? { actor } : {}) }, {});
      expect(out).toMatchObject({ ok: false, error: 'no_caller_identity', status: 412 });
    }
  });

  it('runs a company provider with no actor', async () => {
    const req: HomeRequest = { ...REQ, contract: 'sprigr/home_metrics', provider: 'company_money', scope: 'company' };
    delete (req as Partial<HomeRequest>).person;
    const out = await tool({ provider: 'company_money', _home: req }, {});
    expect(out).toMatchObject({ ok: true, result: { state: 'empty', records: [] } });
  });

  it('refuses plumbing faults by name', async () => {
    expect(await tool({ provider: 'my_day' }, {})).toMatchObject({ ok: false, error: 'not_a_home_dispatch' });
    expect(await tool({ provider: 'my_day', _home: { ...REQ, deadline_ms: 'soon' }, actor: PERSON }, {}))
      .toMatchObject({ ok: false, error: 'invalid_home_request' });
    expect(await tool({ provider: 'nope', _home: { ...REQ, provider: 'nope' }, actor: PERSON }, {}))
      .toMatchObject({ ok: false, error: 'unknown_home_provider', status: 404 });
    expect(await tool({ provider: 'crew_day', _home: REQ, actor: PERSON }, {}))
      .toMatchObject({ ok: false, error: 'provider_mismatch' });
    expect(await tool({ provider: 'my_day', _home: { ...REQ, contract: 'sprigr/home_queue' }, actor: PERSON }, {}))
      .toMatchObject({ ok: false, error: 'contract_mismatch' });
  });

  it('routes on the request when the body carries no provider', async () => {
    const out = await tool({ _home: REQ, actor: PERSON }, { seen: [] });
    expect(out.ok).toBe(true);
  });
});

describe('homeTool errors become Home states', () => {
  class VendorBusy extends Error {}
  const tool = homeTool<Env>({
    mapError: (err) => (err instanceof VendorBusy ? { state: 'rate_limited', retry_after_s: 42 } : err instanceof RangeError ? 'unmapped' : null),
    my_day: schedule(async (_env, _actor, req) => {
      const mode = req.person?.vendor_person_id;
      if (mode === 'nc') throw new NotConnectedError();
      if (mode === 'nc-copy') { const e = new Error('other copy'); e.name = 'NotConnectedError'; throw e; }
      if (mode === 'busy') throw new VendorBusy('slow down');
      if (mode === 'range') throw new RangeError('no such person');
      throw new Error('vendor exploded');
    }),
  });
  const call = (id: string) => tool({ _home: { ...REQ, person: { vendor_person_id: id, method: 'native' } }, actor: PERSON }, {});

  it('turns NotConnectedError (either copy of the class) into not_connected', async () => {
    for (const id of ['nc', 'nc-copy']) {
      expect(await call(id)).toMatchObject({ ok: true, result: { state: 'not_connected', records: [] } });
    }
  });

  it('applies mapError: rate_limited carries retry_after_s, other states none', async () => {
    expect(await call('busy')).toMatchObject({ ok: true, result: { state: 'rate_limited', retry_after_s: 42 } });
    const unmapped = await call('range');
    expect(unmapped).toMatchObject({ ok: true, result: { state: 'unmapped' } });
    if (unmapped.ok) expect(unmapped.result.retry_after_s).toBeUndefined();
  });

  it('returns an unmapped throw as a tool error with its message', async () => {
    expect(await call('other')).toEqual({ ok: false, error: 'vendor exploded' });
  });
});

describe('homeTool shapes the answer as the platform expects', () => {
  it('echoes the request basis whatever the app put there', async () => {
    const tool = homeTool<Env>({
      my_day: schedule(async (_env, _actor, req) => ({ ...home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [] }), basis: { day: '1999-01-01', tz: 'UTC' } })),
    });
    const out = await tool({ _home: REQ, actor: PERSON }, {});
    expect(out.ok && out.result.basis).toEqual({ day: '2026-10-07', tz: 'Australia/Brisbane' });
  });

  it('empties the records of a state that is not ok, and drops a stray retry_after_s and truncated', async () => {
    const tool = homeTool<Env>({
      my_day: schedule(async (_env, _actor, req) => ({ ...home.empty(req), records: [block('1')], retry_after_s: 9, truncated: { at_least: 3 } })),
    });
    const out = await tool({ _home: REQ, actor: PERSON }, {});
    expect(out.ok && out.result).toMatchObject({ state: 'empty', records: [] });
    if (out.ok) {
      expect(out.result.retry_after_s).toBeUndefined();
      expect(out.result.truncated).toBeUndefined();
    }
  });

  it('applies the contract cap and says how many there were', async () => {
    const many = Array.from({ length: 210 }, (_, i) => block(String(i), i));
    const tool = homeTool<Env>({ my_day: schedule(async (_env, _actor, req) => home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: many })) });
    const out = await tool({ _home: REQ, actor: PERSON }, {});
    expect(out.ok && out.result.records).toHaveLength(200);
    expect(out.ok && out.result.truncated).toEqual({ at_least: 210 });
  });

  it('with checkAnswers, refuses an answer the platform would refuse, naming the problem', async () => {
    const badAnswer = homeTool<Env>({
      checkAnswers: true,
      my_day: schedule(async (_env, _actor, req) => home.ok(req, { as_of: 'yesterday', records: [block('1')] })),
    });
    const a = await badAnswer({ _home: REQ, actor: PERSON }, {});
    expect(a).toMatchObject({ ok: false, error: 'invalid_home_answer' });
    if (!a.ok) expect(a.hint).toMatch(/as_of/);

    const badRecord = homeTool<Env>({
      checkAnswers: true,
      my_day: schedule(async (_env, _actor, req) =>
        home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [block('1'), { ...block('2', 1), status: 'teleported' as never }] })),
    });
    const r = await badRecord({ _home: REQ, actor: PERSON }, {});
    expect(r).toMatchObject({ ok: false, error: 'invalid_home_answer' });
    if (!r.ok) expect(r.hint).toMatch(/record 1/);

    const good = homeTool<Env>({ checkAnswers: true, my_day: schedule(async (_env, _actor, req) => home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [block('1')] })) });
    expect((await good({ _home: REQ, actor: PERSON }, {})).ok).toBe(true);
  });
});

describe('identity and queue providers', () => {
  const IDENT: HomeRequest = { ...REQ, contract: 'sprigr/home_identity', provider: 'whoami', purpose: 'identity' };
  delete (IDENT as Partial<HomeRequest>).person;

  it('wraps an identity record into an ok answer with one record', async () => {
    const tool = homeTool<Env>({
      whoami: identity(async () => home.identity({ connection: 'personal', native_person: { vendor_person_id: '7', display_name: 'Sam' } })),
    });
    const out = await tool({ _home: IDENT, actor: PERSON }, {});
    expect(out).toMatchObject({ ok: true, result: { state: 'ok', records: [{ connection: 'personal' }] } });
  });

  it('passes a whole answer from identity through, for states other than ok', async () => {
    const tool = homeTool<Env>({ whoami: identity(async (_env, _actor, req) => home.notConnected(req)) });
    expect(await tool({ _home: IDENT, actor: PERSON }, {})).toMatchObject({ ok: true, result: { state: 'not_connected' } });
  });

  it('runs a queue provider for a person', async () => {
    const req: HomeRequest = { ...REQ, contract: 'sprigr/home_queue', provider: 'new_enquiries', scope: 'company' };
    delete (req as Partial<HomeRequest>).person;
    const tool = homeTool<Env>({ new_enquiries: queue(async (_env, _actor, r) => home.empty(r)) });
    expect(await tool({ _home: req, actor: PERSON }, {})).toMatchObject({ ok: true, result: { state: 'empty' } });
  });
});

describe('answerVersion', () => {
  it('never answers above the request or above what this package serves', () => {
    expect(answerVersion('sprigr/home_schedule', { version: '1.0.0' })).toBe('1.0.0');
    expect(answerVersion('sprigr/home_schedule', { version: '1.9.0' })).toBe('1.0.0');
  });
});

describe('answer helpers', () => {
  it('utc gives a Z instant with no milliseconds from a Date, ms or an offset string', () => {
    expect(home.utc(new Date('2026-10-07T09:30:00+10:00'))).toBe('2026-10-06T23:30:00Z');
    expect(home.utc(Date.UTC(2026, 9, 6, 23, 30))).toBe('2026-10-06T23:30:00Z');
    expect(home.utc('2026-10-07T09:30:00+10:00')).toBe('2026-10-06T23:30:00Z');
    expect(() => home.utc('not a date')).toThrow(/not a date-time/);
    expect(home.plusMinutes('2026-10-06T23:30:00Z', 30)).toBe('2026-10-07T00:00:00Z');
  });

  it('money converts major units to the currency\'s own minor units', () => {
    expect(home.money(12.5, 'aud')).toEqual({ minor: 1250, currency: 'AUD' });
    expect(home.money('12.50', 'AUD')).toEqual({ minor: 1250, currency: 'AUD' });
    expect(home.money(1200, 'JPY')).toEqual({ minor: 1200, currency: 'JPY' });
    expect(home.money(1.234, 'KWD')).toEqual({ minor: 1234, currency: 'KWD' });
    expect(() => home.money('abc', 'AUD')).toThrow();
  });

  it('sumByCurrency sums exactly in minor units and skips rows it cannot read', () => {
    const rows = [
      { amountDue: 0.1, currencyCode: 'AUD' },
      { amountDue: '0.2', currencyCode: 'aud' },
      { amountDue: 'n/a', currencyCode: 'AUD' },
      { amountDue: 5, currencyCode: 'NZD' },
      { amountDue: 7, currencyCode: '' },
    ];
    expect(home.sumByCurrency(rows, 'amountDue', 'currencyCode')).toEqual([
      { currency: 'AUD', minor: 30, count: 2, total: 0.3 },
      { currency: 'NZD', minor: 500, count: 1, total: 5 },
    ]);
  });

  it('builds subjects the platform takes', () => {
    expect(home.subject.email('  Owner@HarbourCafe.example ')).toEqual({ key: 'email', value: 'owner@harbourcafe.example' });
    expect(home.subject.abn('51 824 753 556')).toEqual({ key: 'abn', value: '51824753556' });
    expect(home.subject.ref('job_ref', '1182', 'simpro')).toEqual({ key: 'job_ref', value: '1182', issuer: 'simpro' });
  });
});

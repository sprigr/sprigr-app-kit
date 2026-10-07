/**
 * Home Contracts: record kinds, requests and answers (FINAL-APP-FEEDS 3.1 to
 * 3.3). Every contract gets a round trip (valid JSON in, the same JSON out,
 * no problems) and the refusals that matter: an unknown key, a value outside
 * the vocabulary, the cross-field rules, and the answer-level rules (basis
 * echo, version, state, caps).
 */

import { describe, it, expect } from 'vitest';
import {
  checkHomeAnswer,
  homeRecordProblems,
  homeRequestProblems,
  homeJsonSchema,
  homeResultFields,
  HOME_RECORD_FIELDS,
  HOME_REQUEST_FIELDS,
  HOME_METRIC_IDS,
  HOME_CONTRACT_IDS,
  type HomeContractId,
  type HomeRequest,
} from '../src/index';

const BASIS = { day: '2026-10-07', tz: 'Australia/Brisbane', window_start: '2026-10-06T14:00:00Z', window_end: '2026-10-07T14:00:00Z' };

function request(contract: HomeContractId, over: Partial<HomeRequest> = {}): HomeRequest {
  return { contract, version: '1.0.0', provider: 'my_day', scope: 'me', basis: { ...BASIS }, purpose: 'read', deadline_ms: 3500, ...over };
}

function answer(records: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: '1.0.0',
    state: records.length > 0 ? 'ok' : 'empty',
    as_of: '2026-10-06T21:02:00Z',
    basis: { day: BASIS.day, tz: BASIS.tz },
    records,
    ...over,
  };
}

const VALID: Record<HomeContractId, Record<string, unknown>> = {
  'sprigr/home_schedule': {
    id: 'sched-1',
    kind: 'block',
    start: '2026-10-06T23:30:00Z',
    end: '2026-10-07T01:00:00Z',
    status: 'scheduled',
    category: 'job',
    title: 'Job 1182',
    location: { text: '12 Example Street, Paddington QLD' },
    subjects: [{ key: 'email', value: 'owner@harbourcafe.example' }, { key: 'customer_ref', value: 'C-311', issuer: 'simpro' }],
    same_as: { ical_uid: 'abc@vendor' },
    vendor_tz: 'Australia/Sydney',
    ref: { id: '1182', label: 'Job 1182', link: 'job' },
    detail: [{ label: 'Site contact', value: 'Priya', type: 'string' }, { label: 'Hours', value: 1.5, type: 'number' }],
  },
  'sprigr/home_queue': {
    id: 'lead-77',
    reason: 'customer_waiting',
    why: 'enquiry_new',
    title: 'New enquiry from Harbour Cafe',
    waiting_since: '2026-10-06T19:40:00Z',
    count: 1,
    ref: { id: '77', label: 'Lead 77' },
  },
  'sprigr/home_metrics': {
    metric: 'receivables.overdue',
    value: { kind: 'money', amount: { minor: 189000, currency: 'AUD' } },
    count: 2,
    at_least: false,
    period: { kind: 'instant' },
    compare: { basis: 'yesterday', value: { kind: 'money', amount: { minor: 150000, currency: 'AUD' } } },
    series: [1, 2, 3],
  },
  'sprigr/home_subject_facts': {
    id: 'inv-0042',
    subjects: [{ key: 'email', value: 'owner@harbourcafe.example' }],
    fact: 'overdue_invoice',
    date: '2026-09-30',
    amount: { minor: 64000, currency: 'AUD' },
    ref: { id: '3b1f0c8e-0042', label: 'INV-0042', link: 'invoice' },
  },
  'sprigr/home_identity': {
    connection: 'personal',
    native_person: { vendor_person_id: '7', display_name: 'Priya Rao' },
    people: [{ vendor_person_id: '7', display_name: 'Priya Rao', email: 'priya@example.com', active: true }],
  },
};

describe('record kinds: round trip and closed shape, every contract', () => {
  for (const contract of HOME_CONTRACT_IDS) {
    const rec = VALID[contract];

    it(`${contract}: a valid record survives a JSON round trip with no problems`, () => {
      const wire = JSON.parse(JSON.stringify(rec)) as unknown;
      expect(homeRecordProblems(contract, wire)).toEqual([]);
      expect(wire).toEqual(rec);
    });

    it(`${contract}: an unknown key is refused, never ignored`, () => {
      const problems = homeRecordProblems(contract, { ...rec, colour: 'red' });
      expect(problems.join('; ')).toMatch(/unknown key "colour"/);
    });

    it(`${contract}: a non-object is refused`, () => {
      expect(homeRecordProblems(contract, 'nope')).toEqual(['record must be an object, got "nope"']);
    });
  }

  it('a value outside the vocabulary is refused (newer vocabulary is dropped, 3.3 rule 2)', () => {
    expect(homeRecordProblems('sprigr/home_schedule', { ...VALID['sprigr/home_schedule'], kind: 'shift' }).join()).toMatch(/kind must be one of block, window, deadline, all_day/);
    expect(homeRecordProblems('sprigr/home_queue', { ...VALID['sprigr/home_queue'], why: 'vibes' }).join()).toMatch(/why must be one of/);
    expect(homeRecordProblems('sprigr/home_metrics', { ...VALID['sprigr/home_metrics'], metric: 'profit.vibes' }).join()).toMatch(/metric must be one of/);
    expect(homeRecordProblems('sprigr/home_subject_facts', { ...VALID['sprigr/home_subject_facts'], fact: 'gossip' }).join()).toMatch(/fact must be one of/);
    expect(homeRecordProblems('sprigr/home_identity', { connection: 'maybe' }).join()).toMatch(/connection must be one of/);
  });

  it('subject keys come only from the closed 1.0.0 list', () => {
    const rec = { ...VALID['sprigr/home_subject_facts'], subjects: [{ key: 'phone_e164', value: '+61400000000' }] };
    expect(homeRecordProblems('sprigr/home_subject_facts', rec).join()).toMatch(
      /key must be one of email, order_ref, customer_ref, abn, invoice_ref, job_ref/,
    );
  });

  it('instants must be UTC with a Z suffix and a real date', () => {
    const base = VALID['sprigr/home_schedule'];
    expect(homeRecordProblems('sprigr/home_schedule', { ...base, start: '2026-10-07T09:30:00+10:00' }).join()).toMatch(/UTC instant/);
    expect(homeRecordProblems('sprigr/home_schedule', { ...base, start: '2026-02-30T09:30:00Z' }).join()).toMatch(/UTC instant/);
    expect(homeRecordProblems('sprigr/home_schedule', { ...base, vendor_tz: 'Mars/Olympus' }).join()).toMatch(/IANA time zone/);
  });

  it('caps: title 80, ref.id 128, subjects 4, detail 4, series 30', () => {
    const s = VALID['sprigr/home_schedule'];
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, title: 'x'.repeat(81) }).join()).toMatch(/title is 81 characters; max 80/);
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, ref: { id: 'i'.repeat(129) } }).join()).toMatch(/ref.id is 129 characters; max 128/);
    const subj = { key: 'email', value: 'a@b.example' };
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [subj, subj, subj, subj, subj] }).join()).toMatch(/subjects has 5 entries; max 4/);
    const det = { label: 'a', value: 'b', type: 'string' };
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, detail: [det, det, det, det, det] }).join()).toMatch(/detail has 5 entries; max 4/);
    const m = VALID['sprigr/home_metrics'];
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, series: Array.from({ length: 31 }, () => 1) }).join()).toMatch(/series has 31 entries; max 30/);
  });

  it('money is integer minor units with an ISO 4217 code', () => {
    const m = VALID['sprigr/home_metrics'];
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, value: { kind: 'money', amount: { minor: 18.9, currency: 'AUD' } } }).join()).toMatch(/minor must be an integer/);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, value: { kind: 'money', amount: { minor: 1, currency: 'aud' } } }).join()).toMatch(/ISO 4217/);
  });
});

describe('cross-field rules', () => {
  const s = VALID['sprigr/home_schedule'];

  it('schedule: start unless all_day, end for block and window, day for all_day, end after start', () => {
    const { end: _end, ...noEnd } = s;
    expect(homeRecordProblems('sprigr/home_schedule', noEnd)).toEqual(['record.end is required for a block']);
    expect(homeRecordProblems('sprigr/home_schedule', { ...noEnd, kind: 'deadline' })).toEqual([]);
    const { start: _s, end: _e, ...allDay } = s;
    expect(homeRecordProblems('sprigr/home_schedule', { ...allDay, kind: 'all_day' })).toEqual(['record.day is required for an all_day record']);
    expect(homeRecordProblems('sprigr/home_schedule', { ...allDay, kind: 'all_day', day: '2026-10-07' })).toEqual([]);
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, end: s.start })).toEqual(['record.end must be after record.start']);
  });

  it('schedule: person is required on a crew request', () => {
    const ctx = { request: request('sprigr/home_schedule', { scope: 'crew' }) };
    expect(homeRecordProblems('sprigr/home_schedule', s, ctx)).toEqual(['record.person is required when the request scope is crew']);
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, person: '7' }, ctx)).toEqual([]);
  });

  it('every 1.0.0 subject key is valid in its own shape', () => {
    const subjects = [
      { key: 'email', value: 'owner@harbourcafe.example' },
      { key: 'order_ref', value: '1001', issuer: 'shopify' },
      { key: 'customer_ref', value: 'C-311', issuer: 'simpro' },
      { key: 'abn', value: '51824753556' },
      { key: 'invoice_ref', value: 'INV-0042', issuer: 'xero-accounting' },
      { key: 'job_ref', value: '1182', issuer: 'simpro' },
    ];
    for (const subject of subjects) {
      expect([subject.key, homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [subject] })]).toEqual([subject.key, []]);
    }
  });

  it('each *_ref without an issuer is refused', () => {
    for (const key of ['order_ref', 'customer_ref', 'invoice_ref', 'job_ref']) {
      expect(homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [{ key, value: 'X-1' }] })).toEqual([
        `record.subjects[0].issuer is required for a ${key}: the slug of the app that minted it`,
      ]);
    }
  });

  it('abn: 11 digits that pass the ABN checksum (FINAL-APP-FEEDS 8.4), no issuer', () => {
    const abn = (value: string, extra: Record<string, unknown> = {}) =>
      homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [{ key: 'abn', value, ...extra }] });
    const refused = ['record.subjects[0].value must be an ABN: exactly 11 digits that pass the ABN checksum'];
    expect(abn('51824753556')).toEqual([]);
    expect(abn('53004085616')).toEqual([]);
    expect(abn('51824753557')).toEqual(refused);
    expect(abn('5182475355')).toEqual(refused);
    expect(abn('51 824 753 556')).toEqual(refused);
    expect(abn('ABN51824753556')).toEqual(refused);
    expect(abn('51824753556', { issuer: 'xero-accounting' })).toEqual(['record.subjects[0].issuer is only for *_ref keys']);
  });

  it('subjects: a *_ref needs its issuer, an email does not take one and must look like one', () => {
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [{ key: 'order_ref', value: '1001' }] }).join()).toMatch(/issuer is required for a order_ref/);
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [{ key: 'email', value: 'a@b.example', issuer: 'xero' }] }).join()).toMatch(/issuer is only for \*_ref keys/);
    expect(homeRecordProblems('sprigr/home_schedule', { ...s, subjects: [{ key: 'email', value: 'not an email' }] }).join()).toMatch(/must be an email address/);
  });

  it('queue: severity only on broken, expires_at on expires, reason and why within the declaration', () => {
    const q = VALID['sprigr/home_queue'];
    expect(homeRecordProblems('sprigr/home_queue', { ...q, severity: 'warn' })).toEqual(['record.severity is only for reason broken']);
    expect(homeRecordProblems('sprigr/home_queue', { ...q, reason: 'broken', severity: 'critical' })).toEqual([]);
    expect(homeRecordProblems('sprigr/home_queue', { ...q, reason: 'expires', why: 'quote_expires' })).toEqual(['record.expires_at is required for reason expires']);
    const provider = { reasons: ['customer_waiting' as const], whys: ['enquiry_new' as const] };
    expect(homeRecordProblems('sprigr/home_queue', { ...q, reason: 'fyi' }, { provider })).toEqual(['record.reason "fyi" is not in this provider\'s declared reasons']);
    expect(homeRecordProblems('sprigr/home_queue', { ...q, why: 'task_due' }, { provider })).toEqual(['record.why "task_due" is not in this provider\'s declared whys']);
  });

  it('metrics: declared metric, day period on the basis day, compare of the same kind and currency, range order', () => {
    const m = VALID['sprigr/home_metrics'];
    expect(homeRecordProblems('sprigr/home_metrics', m, { provider: { metrics: ['sales.day'] } })).toEqual(['record.metric "receivables.overdue" is not in this provider\'s declared metrics']);
    const ctx = { request: request('sprigr/home_metrics') };
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, period: { kind: 'day', day: '2026-10-06' } }, ctx)).toEqual(["record.period.day must equal the request's basis.day (2026-10-07)"]);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, period: { kind: 'day', day: '2026-10-07' } }, ctx)).toEqual([]);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, compare: { basis: 'yesterday', value: { kind: 'count', n: 3 } } })).toEqual(['record.compare.value must be the same kind as record.value']);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, compare: { basis: 'yesterday', value: { kind: 'money', amount: { minor: 1, currency: 'NZD' } } } })).toEqual(['record.compare.value must be in the same currency as record.value']);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, period: { kind: 'range', from: '2026-10-07', to: '2026-10-01' } })).toEqual(['record.period.from must not be after record.period.to']);
    expect(homeRecordProblems('sprigr/home_metrics', { ...m, period: { kind: 'week' } }).join()).toMatch(/period.kind must be one of instant, day, range, all_time/);
  });

  it('subject facts: text only on last_visit_note; at least one subject', () => {
    const f = VALID['sprigr/home_subject_facts'];
    expect(homeRecordProblems('sprigr/home_subject_facts', { ...f, text: 'Gate code 1234' })).toEqual(['record.text is only for fact last_visit_note']);
    expect(homeRecordProblems('sprigr/home_subject_facts', { ...f, fact: 'last_visit_note', text: 'Gate code 1234' })).toEqual([]);
    expect(homeRecordProblems('sprigr/home_subject_facts', { ...f, subjects: [] }).join()).toMatch(/subjects must have at least 1 entry/);
  });

  it('ref.link must be a declared link id when the links are known', () => {
    expect(homeRecordProblems('sprigr/home_schedule', s, { linkIds: ['invoice'] })).toEqual(['record.ref.link "job" is not a home.links[].id this app declares']);
    expect(homeRecordProblems('sprigr/home_schedule', s, { linkIds: ['job'] })).toEqual([]);
  });
});

describe('requests', () => {
  it('a platform-built request passes', () => {
    expect(homeRequestProblems(request('sprigr/home_schedule'))).toEqual([]);
    expect(homeRequestProblems(request('sprigr/home_subject_facts', { mode: { kind: 'ref', ref: 'inv-1' } }))).toEqual([]);
  });

  it('refuses an unknown key, a bad zone, an inverted window, a late deadline and mode on schedule', () => {
    expect(homeRequestProblems({ ...request('sprigr/home_schedule'), viewer_email: 'x@y.example' }).join()).toMatch(/unknown key "viewer_email"/);
    expect(homeRequestProblems(request('sprigr/home_schedule', { basis: { ...BASIS, tz: 'Brisbane' } })).join()).toMatch(/IANA time zone/);
    expect(homeRequestProblems(request('sprigr/home_schedule', { basis: { ...BASIS, window_end: BASIS.window_start } }))).toEqual(['request.basis.window_end must be after request.basis.window_start']);
    expect(homeRequestProblems(request('sprigr/home_schedule', { deadline_ms: 5000 })).join()).toMatch(/deadline_ms must be at most 4000/);
    expect(homeRequestProblems(request('sprigr/home_schedule', { mode: { kind: 'bulk' } }))).toEqual(['request.mode is only for sprigr/home_subject_facts and detail requests']);
  });
});

describe('answers: answer-level problems make the whole answer an error', () => {
  const ctx = { request: request('sprigr/home_schedule') };
  const rec = VALID['sprigr/home_schedule'];

  it('a valid answer keeps every record', () => {
    const check = checkHomeAnswer('sprigr/home_schedule', answer([rec]), ctx);
    expect(check).toEqual({ problems: [], records: [rec], dropped: [] });
  });

  it('the basis must echo the request (a UTC-day bug is refused, not drawn)', () => {
    const check = checkHomeAnswer('sprigr/home_schedule', answer([rec], { basis: { day: '2026-10-06', tz: 'UTC' } }), ctx);
    expect(check.problems).toEqual(['answer.basis must echo the request (2026-10-07 Australia/Brisbane), got 2026-10-06 UTC']);
    expect(check.records).toEqual([]);
  });

  it('wrong version: newer than requested, or not served', () => {
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { v: '1.1.0' }), ctx).problems).toEqual(['answer.v 1.1.0 is newer than the requested version 1.0.0']);
    const asks12 = { request: request('sprigr/home_schedule', { version: '1.2.0' }) };
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { v: '1.1.0' }), asks12).problems).toEqual(['answer.v 1.1.0 is not a version the platform serves for sprigr/home_schedule']);
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { v: 'v1' }), ctx).problems.join()).toMatch(/MAJOR.MINOR.PATCH/);
  });

  it('state and records agree; retry_after_s only when rate limited', () => {
    expect(checkHomeAnswer('sprigr/home_schedule', answer([], { state: 'ok' }), ctx).problems).toEqual(['answer.state ok needs at least one record; answer empty instead']);
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { state: 'not_connected' }), ctx).problems).toEqual(['answer.state not_connected must carry no records']);
    expect(checkHomeAnswer('sprigr/home_schedule', answer([], { state: 'rate_limited', retry_after_s: 60 }), ctx).problems).toEqual([]);
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { retry_after_s: 60 }), ctx).problems).toEqual(['answer.retry_after_s is only for state rate_limited']);
  });

  it('caps: 200 schedule records; subject facts 500 in bulk and 20 in ref mode; one identity record', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ ...rec, id: `s-${i}` }));
    expect(checkHomeAnswer('sprigr/home_schedule', answer(many), ctx).problems).toEqual(['answer.records has 201 entries; max 200']);
    const fact = VALID['sprigr/home_subject_facts'];
    const facts = Array.from({ length: 21 }, (_, i) => ({ ...fact, id: `f-${i}` }));
    const refCtx = { request: request('sprigr/home_subject_facts', { mode: { kind: 'ref', ref: 'inv-1' } }) };
    expect(checkHomeAnswer('sprigr/home_subject_facts', answer(facts), refCtx).problems).toEqual(['answer.records has 21 entries; max 20']);
    const bulkCtx = { request: request('sprigr/home_subject_facts', { mode: { kind: 'bulk' } }) };
    expect(checkHomeAnswer('sprigr/home_subject_facts', answer(facts), bulkCtx).problems).toEqual([]);
    const id = VALID['sprigr/home_identity'];
    const idCtx = { request: request('sprigr/home_identity', { purpose: 'identity' }) };
    expect(checkHomeAnswer('sprigr/home_identity', answer([id, id]), idCtx).problems).toEqual(['answer.records has 2 entries; max 1']);
  });

  it('truncated.at_least is a floor at least as large as what came back', () => {
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { truncated: { at_least: 0 } }), ctx).problems).toEqual(['answer.truncated.at_least must be at least the number of records returned']);
  });

  it('an unknown answer key is refused', () => {
    expect(checkHomeAnswer('sprigr/home_schedule', answer([rec], { rank: 1 }), ctx).problems.join()).toMatch(/unknown key "rank"/);
  });

  it('a contract mismatch with the request is refused', () => {
    expect(checkHomeAnswer('sprigr/home_queue', answer([]), ctx).problems).toEqual(['answer is for sprigr/home_queue but the request was for sprigr/home_schedule']);
  });
});

describe('answers: a bad record is dropped, the rest are kept', () => {
  it('drops the one bad record and keeps its neighbours', () => {
    const ctx = { request: request('sprigr/home_schedule') };
    const good = VALID['sprigr/home_schedule'];
    const bad = { ...good, id: 'bad', kind: 'shift' };
    const check = checkHomeAnswer('sprigr/home_schedule', answer([good, bad, { ...good, id: 'sched-2' }]), ctx);
    expect(check.problems).toEqual([]);
    expect(check.records.map((r) => r.id)).toEqual(['sched-1', 'sched-2']);
    expect(check.dropped).toHaveLength(1);
    expect(check.dropped[0]?.index).toBe(1);
  });

  it('metrics: one row per metric and currency', () => {
    const ctx = { request: request('sprigr/home_metrics') };
    const m = VALID['sprigr/home_metrics'];
    const nzd = { ...m, value: { kind: 'money', amount: { minor: 5, currency: 'NZD' } }, compare: undefined };
    const check = checkHomeAnswer('sprigr/home_metrics', answer([m, nzd, m]), ctx);
    expect(check.records).toHaveLength(2);
    expect(check.dropped[0]?.problems).toEqual(['record repeats metric receivables.overdue in AUD; one row per metric and currency']);
  });
});

describe('generated JSON schemas match the validator', () => {
  it('records are closed objects with the validator\'s enums and caps', () => {
    const schema = homeJsonSchema({ type: 'object', fields: HOME_RECORD_FIELDS['sprigr/home_metrics'] }) as {
      additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['metric', 'value', 'period']);
    expect(schema.properties.metric?.enum).toEqual([...HOME_METRIC_IDS]);
  });

  it('the answer schema caps records per contract and the request schema is closed', () => {
    const result = homeJsonSchema({ type: 'object', fields: homeResultFields('sprigr/home_queue', { type: 'object', fields: HOME_RECORD_FIELDS['sprigr/home_queue'] }) }) as {
      properties: { records: { maxItems: number } };
    };
    expect(result.properties.records.maxItems).toBe(50);
    const req = homeJsonSchema({ type: 'object', fields: HOME_REQUEST_FIELDS }) as { additionalProperties: boolean; properties: { deadline_ms: { maximum: number } } };
    expect(req.additionalProperties).toBe(false);
    expect(req.properties.deadline_ms.maximum).toBe(4000);
  });
});

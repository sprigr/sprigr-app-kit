/**
 * Home Contracts: the record kinds, the request and the answer, as field specs
 * (FINAL-APP-FEEDS 3.1 and 3.2), plus the cross-field rules a JSON Schema
 * cannot say.
 *
 * `checkHomeAnswer` is the one validator for an app's answer. It separates two
 * failure classes, because the platform treats them differently:
 *   - a problem with the answer as a whole (a basis that does not echo the
 *     request, a version newer than requested, records on a non-ok state,
 *     over the cap) makes the whole answer `error`;
 *   - a problem with one record (an unknown key, a value outside the
 *     vocabulary, a missing `end` on a block) drops that record only, so one
 *     bad row never blanks a lane (3.3 rule 2: newer vocabulary is dropped).
 * Fixtures are stricter: a fixture with any dropped record is refused
 * (fixtures.ts).
 *
 * Display-string lengths are enforced here. The read path (a later slice)
 * runs the Home sanitizer first, which shortens display strings to these caps
 * with a visible marker, so this check never blanks a lane on read.
 */

import {
  HOME_CONTRACT_IDS,
  HOME_CONTRACT_SERVED_VERSIONS,
  HOME_DETAIL_TYPES,
  HOME_IDENTITY_CONNECTIONS,
  HOME_METRIC_COMPARE_BASES,
  HOME_METRIC_IDS,
  HOME_PERSON_LINK_METHODS,
  HOME_PURPOSES,
  HOME_QUEUE_REASONS,
  HOME_QUEUE_SEVERITIES,
  HOME_QUEUE_WHYS,
  HOME_RECORD_CAPS,
  HOME_SCHEDULE_CATEGORIES,
  HOME_SCHEDULE_KINDS,
  HOME_SCHEDULE_STATUSES,
  HOME_SCOPES,
  HOME_STATES,
  HOME_SUBJECT_FACTS,
  HOME_SUBJECT_KEYS,
  HOME_DISPATCH_TIMEOUT_MS,
  compareHomeVersions,
  type HomeContractId,
} from './vocabulary';
import {
  fmt,
  homeValueProblems,
  isHomeAbn,
  isHomeEmail,
  isPlainHomeObject,
  list,
  obj,
  oneOf,
  opt,
  req,
  str,
  type HomeFieldSpec,
  type HomeObjectFields,
} from './schema';
import type { HomeProviderDeclaration, HomeRecordByContract, HomeRequest } from './types';

// ─── Shared parts ──────────────────────────────────────────────────────────

/** `id` and `ref.id`: the app's own stable ids, at most 128 characters. */
const ID = str(128);

export const HOME_REF_SPEC: HomeFieldSpec = obj({
  id: req(ID),
  label: opt(str(32, { display: true })),
  link: opt(fmt('provider_id')),
});

export const HOME_SUBJECT_SPEC: HomeFieldSpec = obj({
  key: req(oneOf(HOME_SUBJECT_KEYS)),
  value: req(str(256)),
  issuer: opt(fmt('app_slug')),
});

export const HOME_DETAIL_SPEC: HomeFieldSpec = obj({
  label: req(str(24, { display: true })),
  value: req({ type: 'scalar', max: 160, display: true }),
  type: req(oneOf(HOME_DETAIL_TYPES)),
});

export const HOME_MONEY_SPEC: HomeFieldSpec = obj({
  minor: req({ type: 'integer' }),
  currency: req(fmt('currency')),
});

// ─── The five record kinds ─────────────────────────────────────────────────

export const HOME_SCHEDULE_RECORD_FIELDS: HomeObjectFields = {
  id: req(ID),
  kind: req(oneOf(HOME_SCHEDULE_KINDS)),
  start: opt(fmt('instant')),
  end: opt(fmt('instant')),
  day: opt(fmt('local_day')),
  person: opt(str(128)),
  status: req(oneOf(HOME_SCHEDULE_STATUSES)),
  category: req(oneOf(HOME_SCHEDULE_CATEGORIES)),
  title: req(str(80, { display: true }), ['free_text']),
  location: opt(obj({ text: req(str(160, { display: true })) }), ['pii']),
  subjects: opt(list(HOME_SUBJECT_SPEC, { max: 4 }), ['pii']),
  same_as: opt(obj({ ical_uid: opt(str(255)) })),
  vendor_tz: opt(fmt('time_zone')),
  ref: req(HOME_REF_SPEC),
  detail: opt(list(HOME_DETAIL_SPEC, { max: 4 }), ['free_text']),
};

export const HOME_QUEUE_RECORD_FIELDS: HomeObjectFields = {
  id: req(ID),
  reason: req(oneOf(HOME_QUEUE_REASONS)),
  why: req(oneOf(HOME_QUEUE_WHYS)),
  severity: opt(oneOf(HOME_QUEUE_SEVERITIES)),
  title: req(str(80, { display: true }), ['free_text']),
  waiting_since: opt(fmt('instant')),
  due_at: opt(fmt('instant')),
  expires_at: opt(fmt('instant')),
  count: opt({ type: 'integer', min: 1 }),
  subjects: opt(list(HOME_SUBJECT_SPEC, { max: 4 }), ['pii']),
  ref: req(HOME_REF_SPEC),
};

const METRIC_VALUE_SPEC: HomeFieldSpec = {
  type: 'tagged',
  tag: 'kind',
  variants: {
    money: { amount: req(HOME_MONEY_SPEC, ['financial_cost']) },
    count: { n: req({ type: 'integer', min: 0 }) },
  },
};

const METRIC_PERIOD_SPEC: HomeFieldSpec = {
  type: 'tagged',
  tag: 'kind',
  variants: {
    instant: {},
    day: { day: req(fmt('local_day')) },
    range: { from: req(fmt('local_day')), to: req(fmt('local_day')) },
    all_time: {},
  },
};

export const HOME_METRIC_RECORD_FIELDS: HomeObjectFields = {
  metric: req(oneOf(HOME_METRIC_IDS)),
  value: req(METRIC_VALUE_SPEC),
  count: opt({ type: 'integer', min: 0 }),
  at_least: opt({ type: 'boolean' }),
  period: req(METRIC_PERIOD_SPEC),
  compare: opt(obj({ basis: req(oneOf(HOME_METRIC_COMPARE_BASES)), value: req(METRIC_VALUE_SPEC) })),
  // Tagged financial_cost because the points of a money metric are money; tags are a floor.
  series: opt(list({ type: 'number' }, { max: 30 }), ['financial_cost']),
  ref: opt(HOME_REF_SPEC),
};

export const HOME_SUBJECT_FACT_RECORD_FIELDS: HomeObjectFields = {
  id: req(ID),
  subjects: req(list(HOME_SUBJECT_SPEC, { min: 1, max: 4 }), ['pii']),
  fact: req(oneOf(HOME_SUBJECT_FACTS)),
  date: opt(fmt('local_day')),
  amount: opt(HOME_MONEY_SPEC, ['financial_cost']),
  text: opt(str(160, { display: true }), ['free_text']),
  ref: req(HOME_REF_SPEC),
};

const PERSON_ID = str(128);
const DISPLAY_NAME = str(80, { display: true });

export const HOME_IDENTITY_RECORD_FIELDS: HomeObjectFields = {
  connection: req(oneOf(HOME_IDENTITY_CONNECTIONS)),
  native_person: opt(obj({ vendor_person_id: req(PERSON_ID), display_name: req(DISPLAY_NAME, ['pii']) })),
  people: opt(
    list(
      obj({
        vendor_person_id: req(PERSON_ID),
        display_name: req(DISPLAY_NAME, ['pii']),
        email: opt(fmt('email'), ['pii', 'contact']),
        active: req({ type: 'boolean' }),
      }),
      { max: 500 },
    ),
  ),
};

/** The record fields of each contract. */
export const HOME_RECORD_FIELDS: Readonly<Record<HomeContractId, HomeObjectFields>> = {
  'sprigr/home_schedule': HOME_SCHEDULE_RECORD_FIELDS,
  'sprigr/home_queue': HOME_QUEUE_RECORD_FIELDS,
  'sprigr/home_metrics': HOME_METRIC_RECORD_FIELDS,
  'sprigr/home_subject_facts': HOME_SUBJECT_FACT_RECORD_FIELDS,
  'sprigr/home_identity': HOME_IDENTITY_RECORD_FIELDS,
};

/** The record name each contract's definition publishes. */
export const HOME_RECORD_NAMES: Readonly<Record<HomeContractId, string>> = {
  'sprigr/home_schedule': 'schedule_record',
  'sprigr/home_queue': 'queue_record',
  'sprigr/home_metrics': 'metric_record',
  'sprigr/home_subject_facts': 'subject_fact_record',
  'sprigr/home_identity': 'identity_record',
};

// ─── The request and the answer ────────────────────────────────────────────

export const HOME_REQUEST_FIELDS: HomeObjectFields = {
  contract: req(oneOf(HOME_CONTRACT_IDS)),
  version: req(fmt('semver')),
  provider: req(fmt('provider_id')),
  scope: req(oneOf(HOME_SCOPES)),
  basis: req(
    obj({
      day: req(fmt('local_day')),
      tz: req(fmt('time_zone')),
      window_start: req(fmt('instant')),
      window_end: req(fmt('instant')),
    }),
  ),
  person: opt(obj({ vendor_person_id: req(PERSON_ID), method: req(oneOf(HOME_PERSON_LINK_METHODS)) })),
  mode: opt({ type: 'tagged', tag: 'kind', variants: { bulk: {}, ref: { ref: req(ID) } } }),
  purpose: req(oneOf(HOME_PURPOSES)),
  deadline_ms: req({ type: 'integer', min: 1, max: HOME_DISPATCH_TIMEOUT_MS }),
};

/** The cap the JSON Schema states; subject_facts in ref mode is tighter at runtime. */
function schemaCap(contract: HomeContractId): number {
  const cap = HOME_RECORD_CAPS[contract];
  return typeof cap === 'number' ? cap : cap.bulk;
}

/** The answer's fields, with `records` typed as `items` and capped at `cap` (the published cap by default). */
export function homeResultFields(contract: HomeContractId, items: HomeFieldSpec, cap: number = schemaCap(contract)): HomeObjectFields {
  return {
    v: req(fmt('semver')),
    state: req(oneOf(HOME_STATES)),
    as_of: req(fmt('instant')),
    stale_after: opt(fmt('instant')),
    next_refresh_at: opt(fmt('instant')),
    basis: req(obj({ day: req(fmt('local_day')), tz: req(fmt('time_zone')) })),
    records: req(list(items, { max: cap })),
    truncated: opt(obj({ at_least: req({ type: 'integer', min: 0 }) })),
    retry_after_s: opt({ type: 'integer', min: 1, max: 86400 }),
  };
}

/** Records are checked one by one below, so a bad one is dropped, not fatal. */
const ANY_RECORD: HomeFieldSpec = { type: 'any' };

// ─── Cross-field rules ─────────────────────────────────────────────────────

function subjectProblems(subjects: unknown, path: string, out: string[]): void {
  if (!Array.isArray(subjects)) return;
  subjects.forEach((s, i) => {
    if (!isPlainHomeObject(s)) return;
    const p = `${path}[${i}]`;
    if (typeof s.key === 'string' && s.key.endsWith('_ref') && s.issuer === undefined) {
      out.push(`${p}.issuer is required for a ${s.key}: the slug of the app that minted it`);
    }
    if (typeof s.key === 'string' && !s.key.endsWith('_ref') && s.issuer !== undefined) out.push(`${p}.issuer is only for *_ref keys`);
    if (s.key === 'email' && !isHomeEmail(typeof s.value === 'string' ? s.value.trim() : s.value)) {
      out.push(`${p}.value must be an email address for key email`);
    }
    if (s.key === 'abn' && !isHomeAbn(s.value)) {
      out.push(`${p}.value must be an ABN: exactly 11 digits that pass the ABN checksum`);
    }
  });
}

/** What a record's cross-field rules may consult. */
export interface HomeRecordContext {
  /** The request this record answers; enables the crew and basis-day rules. */
  request?: Pick<HomeRequest, 'scope' | 'basis'>;
  /** The provider declaration; a record outside its declared vocabulary is dropped. */
  provider?: Pick<HomeProviderDeclaration, 'metrics' | 'facts' | 'reasons' | 'whys'>;
  /** The manifest's `home.links[].id`s; a `ref.link` outside them is dropped. */
  linkIds?: readonly string[];
}

function refLinkProblem(rec: Record<string, unknown>, ctx: HomeRecordContext, out: string[]): void {
  const ref = rec.ref;
  if (!ctx.linkIds || !isPlainHomeObject(ref) || ref.link === undefined) return;
  if (typeof ref.link === 'string' && !ctx.linkIds.includes(ref.link)) {
    out.push(`record.ref.link "${ref.link}" is not a home.links[].id this app declares`);
  }
}

function crossFieldProblems(contract: HomeContractId, rec: Record<string, unknown>, ctx: HomeRecordContext, out: string[]): void {
  refLinkProblem(rec, ctx, out);
  switch (contract) {
    case 'sprigr/home_schedule': {
      const kind = rec.kind;
      if (kind !== 'all_day' && rec.start === undefined) out.push(`record.start is required for a ${String(kind)}`);
      if ((kind === 'block' || kind === 'window') && rec.end === undefined) out.push(`record.end is required for a ${String(kind)}`);
      if (kind === 'all_day' && rec.day === undefined) out.push('record.day is required for an all_day record');
      if (typeof rec.start === 'string' && typeof rec.end === 'string') {
        const s = Date.parse(rec.start);
        const e = Date.parse(rec.end);
        if (e < s || ((kind === 'block' || kind === 'window') && e === s)) out.push('record.end must be after record.start');
      }
      if (ctx.request?.scope === 'crew' && rec.person === undefined) out.push('record.person is required when the request scope is crew');
      subjectProblems(rec.subjects, 'record.subjects', out);
      return;
    }
    case 'sprigr/home_queue': {
      if (rec.severity !== undefined && rec.reason !== 'broken') out.push('record.severity is only for reason broken');
      if (rec.reason === 'expires' && rec.expires_at === undefined) out.push('record.expires_at is required for reason expires');
      const p = ctx.provider;
      if (p?.reasons && typeof rec.reason === 'string' && !(p.reasons as readonly string[]).includes(rec.reason)) {
        out.push(`record.reason "${rec.reason}" is not in this provider's declared reasons`);
      }
      if (p?.whys && typeof rec.why === 'string' && !(p.whys as readonly string[]).includes(rec.why)) {
        out.push(`record.why "${rec.why}" is not in this provider's declared whys`);
      }
      subjectProblems(rec.subjects, 'record.subjects', out);
      return;
    }
    case 'sprigr/home_metrics': {
      const p = ctx.provider;
      if (p?.metrics && typeof rec.metric === 'string' && !(p.metrics as readonly string[]).includes(rec.metric)) {
        out.push(`record.metric "${rec.metric}" is not in this provider's declared metrics`);
      }
      const period = rec.period;
      if (isPlainHomeObject(period)) {
        if (period.kind === 'range' && typeof period.from === 'string' && typeof period.to === 'string' && period.from > period.to) {
          out.push('record.period.from must not be after record.period.to');
        }
        if (period.kind === 'day' && ctx.request && period.day !== ctx.request.basis.day) {
          out.push(`record.period.day must equal the request's basis.day (${ctx.request.basis.day})`);
        }
      }
      const value = rec.value;
      const compare = rec.compare;
      if (isPlainHomeObject(value) && isPlainHomeObject(compare) && isPlainHomeObject(compare.value)) {
        if (compare.value.kind !== value.kind) {
          out.push('record.compare.value must be the same kind as record.value');
        } else if (
          value.kind === 'money' &&
          isPlainHomeObject(value.amount) &&
          isPlainHomeObject(compare.value.amount) &&
          value.amount.currency !== compare.value.amount.currency
        ) {
          out.push('record.compare.value must be in the same currency as record.value');
        }
      }
      return;
    }
    case 'sprigr/home_subject_facts': {
      if (rec.text !== undefined && rec.fact !== 'last_visit_note') out.push('record.text is only for fact last_visit_note');
      const p = ctx.provider;
      if (p?.facts && typeof rec.fact === 'string' && !(p.facts as readonly string[]).includes(rec.fact)) {
        out.push(`record.fact "${rec.fact}" is not in this provider's declared facts`);
      }
      subjectProblems(rec.subjects, 'record.subjects', out);
      return;
    }
    case 'sprigr/home_identity':
      return;
  }
}

/** Every problem with one record of `contract`. Empty means valid. */
export function homeRecordProblems(contract: HomeContractId, record: unknown, ctx: HomeRecordContext = {}): string[] {
  const out = homeValueProblems(record, { type: 'object', fields: HOME_RECORD_FIELDS[contract] }, 'record');
  if (out.length > 0 || !isPlainHomeObject(record)) return out;
  crossFieldProblems(contract, record, ctx, out);
  return out;
}

/** Every problem with a request. Empty means valid. */
export function homeRequestProblems(request: unknown): string[] {
  const out = homeValueProblems(request, { type: 'object', fields: HOME_REQUEST_FIELDS }, 'request');
  if (out.length > 0 || !isPlainHomeObject(request) || !isPlainHomeObject(request.basis)) return out;
  const b = request.basis;
  if (typeof b.window_start === 'string' && typeof b.window_end === 'string' && Date.parse(b.window_end) <= Date.parse(b.window_start)) {
    out.push('request.basis.window_end must be after request.basis.window_start');
  }
  const mode = request.mode;
  if (mode !== undefined && request.contract !== 'sprigr/home_subject_facts' && request.purpose !== 'detail') {
    out.push('request.mode is only for sprigr/home_subject_facts and detail requests');
  }
  return out;
}

export interface HomeAnswerContext extends HomeRecordContext {
  request: HomeRequest;
}

export interface HomeAnswerCheck<R> {
  /** Problems with the answer as a whole. Non-empty means the platform treats it as state 'error'. */
  problems: string[];
  /** The records that passed, in order. */
  records: R[];
  /** Records refused one by one: never rendered, never cached. */
  dropped: Array<{ index: number; problems: string[] }>;
}

/** The cap that applies to one answer. */
export function homeRecordCap(contract: HomeContractId, request?: Pick<HomeRequest, 'mode'>): number {
  const cap = HOME_RECORD_CAPS[contract];
  if (typeof cap === 'number') return cap;
  return request?.mode?.kind === 'ref' ? cap.ref : cap.bulk;
}

/**
 * Validate an app's answer to `ctx.request`. See the file comment for the
 * answer-level versus record-level split.
 */
export function checkHomeAnswer<C extends HomeContractId>(
  contract: C,
  answer: unknown,
  ctx: HomeAnswerContext,
  /** How messages name the answer: `answer`, or `expect` in a fixture. */
  root = 'answer',
): HomeAnswerCheck<HomeRecordByContract[C]> {
  const result: HomeAnswerCheck<HomeRecordByContract[C]> = { problems: [], records: [], dropped: [] };
  const cap = homeRecordCap(contract, ctx.request);
  result.problems.push(...homeValueProblems(answer, { type: 'object', fields: homeResultFields(contract, ANY_RECORD, cap) }, root));
  if (!isPlainHomeObject(answer)) return result;
  if (ctx.request.contract !== contract) {
    result.problems.push(`${root} is for ${contract} but the request was for ${ctx.request.contract}`);
  }

  const v = answer.v;
  if (typeof v === 'string') {
    if (compareHomeVersions(v, ctx.request.version) > 0) {
      result.problems.push(`${root}.v ${v} is newer than the requested version ${ctx.request.version}`);
    } else if (!HOME_CONTRACT_SERVED_VERSIONS[contract].includes(v)) {
      result.problems.push(`${root}.v ${v} is not a version the platform serves for ${contract}`);
    }
  }
  const basis = answer.basis;
  if (isPlainHomeObject(basis) && (basis.day !== ctx.request.basis.day || basis.tz !== ctx.request.basis.tz)) {
    result.problems.push(
      `${root}.basis must echo the request (${ctx.request.basis.day} ${ctx.request.basis.tz}), got ${String(basis.day)} ${String(basis.tz)}`,
    );
  }
  const records = Array.isArray(answer.records) ? answer.records : [];
  const state = answer.state;
  if (state === 'ok' && records.length === 0) result.problems.push(`${root}.state ok needs at least one record; answer empty instead`);
  if (typeof state === 'string' && state !== 'ok' && records.length > 0) {
    result.problems.push(`${root}.state ${state} must carry no records`);
  }
  if (answer.retry_after_s !== undefined && state !== 'rate_limited') {
    result.problems.push(`${root}.retry_after_s is only for state rate_limited`);
  }
  const truncated = answer.truncated;
  if (isPlainHomeObject(truncated) && typeof truncated.at_least === 'number' && truncated.at_least < records.length) {
    result.problems.push(`${root}.truncated.at_least must be at least the number of records returned`);
  }
  if (result.problems.length > 0) return result;

  const seenMetric = new Set<string>();
  records.forEach((rec, index) => {
    const p = homeRecordProblems(contract, rec, ctx);
    if (p.length === 0 && contract === 'sprigr/home_metrics' && isPlainHomeObject(rec) && isPlainHomeObject(rec.value)) {
      // One row per (metric, currency) per answer: the platform never sums or picks between two.
      const amount = rec.value.amount;
      const unit = rec.value.kind === 'money' && isPlainHomeObject(amount) ? String(amount.currency) : 'count';
      const key = `${String(rec.metric)}|${unit}`;
      if (seenMetric.has(key)) p.push(`record repeats metric ${String(rec.metric)} in ${unit}; one row per metric and currency`);
      seenMetric.add(key);
    }
    if (p.length > 0) result.dropped.push({ index, problems: p });
    else result.records.push(rec as HomeRecordByContract[C]);
  });
  return result;
}

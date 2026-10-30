/**
 * The Home SDK: what an app writes its one Home tool with (FINAL-APP-FEEDS
 * section 12, slice 2a-6).
 *
 *   export const get_my_app_home = homeTool({
 *     mapError: (err) => (err instanceof MyRateLimit ? { state: 'rate_limited', retry_after_s: 60 } : null),
 *     whoami: identity(async (env, actor) => home.identity({ connection: 'personal', people })),
 *     my_day: schedule(async (env, actor, req) => home.ok(req, { as_of, records })),
 *     overdue: metrics(async (env, req) => home.empty(req), { audience: 'company' }),
 *   });
 *
 * The platform's wrapper (sprigr-team decision 0177) sends the Home tool
 * `{ provider }` and builds `args._home` (the HomeRequest) and `args.actor`
 * only on a genuine Home dispatch; a body copy of either never reaches the
 * handler. So this reads `args._home` and never looks at a header.
 *
 * What `homeTool` does around each provider:
 *  - routes on the provider and refuses a request for another contract, or
 *    one the platform's own request check would refuse;
 *  - for a `per_user` provider (the default) requires a PERSON:
 *    `args.actor.platformUserId`. An agent-only actor is refused as
 *    `no_caller_identity`, which is why this does not use app-sdk's
 *    `actorTool` (that accepts an agentId alone);
 *  - turns app-sdk's `NotConnectedError` into a `not_connected` answer, and
 *    `mapError` into any other state;
 *  - echoes the request's basis, sets `v` to the version this package
 *    answers (never above the request's), empties the records of any state
 *    but `ok`, and applies the contract's record cap with `truncated`;
 *  - with `checkAnswers: true` (development and tests), refuses an answer
 *    the platform would refuse, naming every problem.
 *
 * An answer is always returned as `{ ok: true, result }`, whatever its
 * state: `not_connected` and `rate_limited` are Home states the platform
 * draws, not tool errors. `{ ok: false }` is kept for plumbing faults (no
 * request, no person, an unknown provider) and for a handler that throws
 * something unmapped.
 */

import { isNotConnectedError, parseActor, type Actor, type ToolResult } from '@sprigr/apps-app-sdk';
import { checkHomeAnswer, homeRecordCap, homeRequestProblems } from './records';
import type {
  HomeRequest,
  HomeResult,
  IdentityRecord,
  MetricRecord,
  Money,
  QueueRecord,
  ScheduleRecord,
  Subject,
  SubjectFactRecord,
} from './types';
import {
  HOME_CONTRACT_SERVED_VERSIONS,
  type HomeAudience,
  type HomeContractId,
  type HomeState,
} from './vocabulary';

// ─── Providers ─────────────────────────────────────────────────────────────

/** A provider as `homeTool` holds it. Built by `schedule`, `queue`, `metrics`, `subjectFacts` and `identity`. */
export interface HomeProvider<Env> {
  readonly contract: HomeContractId;
  readonly audience: HomeAudience;
  readonly run: (env: Env, actor: Actor | null, req: HomeRequest) => Promise<HomeResult<unknown>>;
}

/** A provider answering for the viewer: the platform stamps them as `args.actor`. */
export type PersonHomeHandler<Env, R> = (env: Env, actor: Actor, req: HomeRequest) => Promise<HomeResult<R>>;
/** A company-audience provider: one answer for every viewer, and no actor. */
export type CompanyHomeHandler<Env, R> = (env: Env, req: HomeRequest) => Promise<HomeResult<R>>;

function provider<Env>(
  contract: HomeContractId,
  fn: PersonHomeHandler<Env, unknown> | CompanyHomeHandler<Env, unknown>,
  opts?: { audience: 'company' },
): HomeProvider<Env> {
  if (opts?.audience === 'company') {
    const run = fn as CompanyHomeHandler<Env, unknown>;
    return { contract, audience: 'company', run: (env, _actor, req) => run(env, req) };
  }
  const run = fn as PersonHomeHandler<Env, unknown>;
  return { contract, audience: 'per_user', run: (env, actor, req) => run(env, actor as Actor, req) };
}

/** A `sprigr/home_schedule` provider. `per_user` unless `{ audience: 'company' }`. */
export function schedule<Env>(fn: PersonHomeHandler<Env, ScheduleRecord>): HomeProvider<Env>;
export function schedule<Env>(fn: CompanyHomeHandler<Env, ScheduleRecord>, opts: { audience: 'company' }): HomeProvider<Env>;
export function schedule<Env>(fn: PersonHomeHandler<Env, ScheduleRecord> | CompanyHomeHandler<Env, ScheduleRecord>, opts?: { audience: 'company' }): HomeProvider<Env> {
  return provider('sprigr/home_schedule', fn as PersonHomeHandler<Env, unknown>, opts);
}

/** A `sprigr/home_queue` provider. `per_user` unless `{ audience: 'company' }`. */
export function queue<Env>(fn: PersonHomeHandler<Env, QueueRecord>): HomeProvider<Env>;
export function queue<Env>(fn: CompanyHomeHandler<Env, QueueRecord>, opts: { audience: 'company' }): HomeProvider<Env>;
export function queue<Env>(fn: PersonHomeHandler<Env, QueueRecord> | CompanyHomeHandler<Env, QueueRecord>, opts?: { audience: 'company' }): HomeProvider<Env> {
  return provider('sprigr/home_queue', fn as PersonHomeHandler<Env, unknown>, opts);
}

/** A `sprigr/home_metrics` provider. `per_user` unless `{ audience: 'company' }`. */
export function metrics<Env>(fn: PersonHomeHandler<Env, MetricRecord>): HomeProvider<Env>;
export function metrics<Env>(fn: CompanyHomeHandler<Env, MetricRecord>, opts: { audience: 'company' }): HomeProvider<Env>;
export function metrics<Env>(fn: PersonHomeHandler<Env, MetricRecord> | CompanyHomeHandler<Env, MetricRecord>, opts?: { audience: 'company' }): HomeProvider<Env> {
  return provider('sprigr/home_metrics', fn as PersonHomeHandler<Env, unknown>, opts);
}

/** A `sprigr/home_subject_facts` provider. `per_user` unless `{ audience: 'company' }`. */
export function subjectFacts<Env>(fn: PersonHomeHandler<Env, SubjectFactRecord>): HomeProvider<Env>;
export function subjectFacts<Env>(fn: CompanyHomeHandler<Env, SubjectFactRecord>, opts: { audience: 'company' }): HomeProvider<Env>;
export function subjectFacts<Env>(fn: PersonHomeHandler<Env, SubjectFactRecord> | CompanyHomeHandler<Env, SubjectFactRecord>, opts?: { audience: 'company' }): HomeProvider<Env> {
  return provider('sprigr/home_subject_facts', fn as PersonHomeHandler<Env, unknown>, opts);
}

/**
 * The `sprigr/home_identity` provider: who the viewer is in the vendor. Always
 * for a person (the platform stamps the viewer). Return the record
 * (`home.identity(...)`), or a whole answer for any other state
 * (`home.notConnected(req)`).
 */
export function identity<Env>(
  fn: (env: Env, actor: Actor, req: HomeRequest) => Promise<IdentityRecord | HomeResult<IdentityRecord>>,
): HomeProvider<Env> {
  return {
    contract: 'sprigr/home_identity',
    audience: 'per_user',
    run: async (env, actor, req) => {
      const out = await fn(env, actor as Actor, req);
      return isHomeResult(out) ? out : home.ok(req, { as_of: nowInstant(), records: [out] });
    },
  };
}

function isHomeResult(v: unknown): v is HomeResult<unknown> {
  return !!v && typeof v === 'object' && typeof (v as { state?: unknown }).state === 'string' && Array.isArray((v as { records?: unknown }).records);
}

// ─── homeTool ──────────────────────────────────────────────────────────────

/** What `mapError` may turn an app's own error into. `null` falls through to a tool error. */
export type HomeErrorMapping =
  | 'not_connected'
  | 'colleague_only'
  | 'unmapped'
  | 'error'
  | { state: 'rate_limited'; retry_after_s: number }
  | null;

export interface HomeToolOptions {
  /** Map an app's own error to a Home state. Runs after the `NotConnectedError` check. */
  mapError?: (err: unknown) => HomeErrorMapping;
  /**
   * Refuse an answer the platform would refuse, naming the problems. For
   * development and tests: in production the platform runs the same check
   * and drops what fails.
   */
  checkAnswers?: boolean;
}

/** The arguments a Home dispatch hands the Home tool. Only the platform wrapper sets `_home` and `actor`. */
export interface HomeToolArgs {
  provider?: string;
  _home?: unknown;
  actor?: unknown;
}

export type HomeToolHandler<Env> = (args: HomeToolArgs, env: Env) => Promise<ToolResult<HomeResult<unknown>>>;

const RESERVED_OPTION_KEYS = new Set(['mapError', 'checkAnswers']);

const NO_PERSON_HINT =
  'A Home provider for a person needs the platform-stamped viewer (args.actor.platformUserId). ' +
  'An agent-only actor is not a person; the platform stamps the viewer on every Home dispatch.';

/**
 * Build an app's one Home tool from its providers, keyed by the manifest's
 * `provides[].id` (and the identity provider id). `mapError` and
 * `checkAnswers` are options, not providers: a provider id is lowercase.
 */
export function homeTool<Env>(
  spec: HomeToolOptions & { [providerId: string]: HomeProvider<Env> | HomeToolOptions[keyof HomeToolOptions] },
): HomeToolHandler<Env> {
  const providers = new Map<string, HomeProvider<Env>>();
  for (const [key, value] of Object.entries(spec)) {
    if (RESERVED_OPTION_KEYS.has(key)) continue;
    providers.set(key, value as HomeProvider<Env>);
  }
  const opts: HomeToolOptions = { mapError: spec.mapError, checkAnswers: spec.checkAnswers };

  return async (args, env) => {
    const req = args?._home as HomeRequest | undefined;
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'not_a_home_dispatch', status: 400, hint: 'args._home is set only by the platform, on a Home dispatch.' };
    }
    const requestProblems = homeRequestProblems(req);
    if (requestProblems.length > 0) {
      return { ok: false, error: 'invalid_home_request', status: 400, hint: requestProblems.join('; ') };
    }
    const id = typeof args.provider === 'string' && args.provider ? args.provider : req.provider;
    if (id !== req.provider) {
      return { ok: false, error: 'provider_mismatch', status: 400, hint: `args.provider is ${id} but the request is for ${req.provider}` };
    }
    const p = providers.get(id);
    if (!p) return { ok: false, error: 'unknown_home_provider', status: 404, hint: `no provider ${id} in this Home tool` };
    if (p.contract !== req.contract) {
      return { ok: false, error: 'contract_mismatch', status: 400, hint: `provider ${id} answers ${p.contract}, not ${req.contract}` };
    }

    let actor: Actor | null = null;
    if (p.audience === 'per_user') {
      const parsed = parseActor(args);
      if (!parsed?.platformUserId) return { ok: false, error: 'no_caller_identity', status: 412, hint: NO_PERSON_HINT };
      actor = parsed;
    }

    let answer: HomeResult<unknown>;
    try {
      answer = await p.run(env, actor, req);
    } catch (err) {
      if (isNotConnectedError(err)) {
        answer = home.notConnected(req);
      } else {
        const mapped = opts.mapError?.(err) ?? null;
        if (mapped === null) return { ok: false, error: err instanceof Error ? err.message : String(err) };
        answer = typeof mapped === 'string' ? stateAnswer(req, mapped) : home.rateLimited(req, mapped.retry_after_s);
      }
    }

    const shaped = shapeAnswer(p.contract, req, answer);
    if (opts.checkAnswers) {
      const check = checkHomeAnswer(p.contract, shaped, { request: req });
      const problems = [...check.problems, ...check.dropped.map((d) => `record ${d.index}: ${d.problems.join(', ')}`)];
      if (problems.length > 0) return { ok: false, error: 'invalid_home_answer', hint: problems.join('; ') };
    }
    return { ok: true, result: shaped };
  };
}

/** The platform's rules an app gets for free: basis echo, `v`, records only when ok, the cap. */
function shapeAnswer(contract: HomeContractId, req: HomeRequest, answer: HomeResult<unknown>): HomeResult<unknown> {
  const out: HomeResult<unknown> = {
    ...answer,
    v: answerVersion(contract, req, answer.v),
    basis: { day: req.basis.day, tz: req.basis.tz },
    records: answer.state === 'ok' && Array.isArray(answer.records) ? answer.records : [],
  };
  if (out.state !== 'rate_limited') delete out.retry_after_s;
  if (out.state !== 'ok') delete out.truncated;
  const cap = homeRecordCap(contract, req);
  if (out.records.length > cap) {
    const atLeast = Math.max(out.records.length, out.truncated?.at_least ?? 0);
    out.records = out.records.slice(0, cap);
    out.truncated = { at_least: atLeast };
  }
  return out;
}

// ─── Versions ──────────────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The version an answer is stamped with: the highest this package's contract
 * serves that is not above the request's, and not above the app's own `v`
 * when it set a lower one. Every record kind and field is 1.0.0 today; when a
 * minor adds one, this is where a record newer than the request is dropped.
 */
export function answerVersion(contract: HomeContractId, req: Pick<HomeRequest, 'version'>, appV?: string): string {
  const served = HOME_CONTRACT_SERVED_VERSIONS[contract].filter((v) => compareVersions(v, req.version) <= 0);
  const sorted = served.sort(compareVersions);
  let v = sorted.length > 0 ? sorted[sorted.length - 1]! : req.version;
  if (typeof appV === 'string' && /^\d+\.\d+\.\d+$/.test(appV) && compareVersions(appV, v) < 0) v = appV;
  return v;
}

// ─── Answer helpers ────────────────────────────────────────────────────────

function nowInstant(): string {
  return new Date().toISOString().replace('.000Z', 'Z');
}

function stateAnswer(req: HomeRequest, state: Exclude<HomeState, 'ok' | 'rate_limited'>, asOf?: string): HomeResult<never> {
  return { v: req.version, state, as_of: asOf ?? nowInstant(), basis: { day: req.basis.day, tz: req.basis.tz }, records: [] };
}

/** ISO 4217 minor-unit digits that are not 2 (the default). */
const MINOR_DIGITS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0, KWD: 3,
  LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

function toMinor(amount: number | string, currency: string): number {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new Error(`home.money: ${String(amount)} is not a number`);
  return Math.round(n * 10 ** minorDigits(currency));
}

export const home = {
  /** An answer with records. `v` and `basis` are set for you (homeTool sets them again). */
  ok<R>(req: HomeRequest, a: { as_of: string; records: R[]; stale_after?: string; next_refresh_at?: string; truncated?: { at_least: number } }): HomeResult<R> {
    return {
      v: req.version,
      state: 'ok',
      as_of: a.as_of,
      basis: { day: req.basis.day, tz: req.basis.tz },
      records: a.records,
      ...(a.stale_after ? { stale_after: a.stale_after } : {}),
      ...(a.next_refresh_at ? { next_refresh_at: a.next_refresh_at } : {}),
      ...(a.truncated ? { truncated: a.truncated } : {}),
    };
  },
  /** Nothing to show, and that is the truth (not an error). */
  empty: (req: HomeRequest, a: { as_of?: string } = {}): HomeResult<never> => stateAnswer(req, 'empty', a.as_of),
  /** The viewer has not connected their own account. */
  notConnected: (req: HomeRequest): HomeResult<never> => stateAnswer(req, 'not_connected'),
  /** The viewer is not linked to a person in the vendor, so a person's provider cannot answer. */
  unmapped: (req: HomeRequest): HomeResult<never> => stateAnswer(req, 'unmapped'),
  /** Only a colleague's connection could answer; the platform never borrows it. */
  colleagueOnly: (req: HomeRequest): HomeResult<never> => stateAnswer(req, 'colleague_only'),
  /** The app could not answer. */
  error: (req: HomeRequest): HomeResult<never> => stateAnswer(req, 'error'),
  /** The vendor (or the app's own budget) says wait. */
  rateLimited(req: HomeRequest, retryAfterS: number): HomeResult<never> {
    return { ...stateAnswer(req, 'error'), state: 'rate_limited', retry_after_s: Math.max(1, Math.round(retryAfterS)) };
  },
  /** The identity record; return it from an `identity(...)` provider. */
  identity: (record: IdentityRecord): IdentityRecord => record,

  /** A Date, epoch ms, or any parseable date-time to a UTC `Z` instant (no milliseconds). */
  utc(when: Date | number | string): string {
    const ms = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
    if (!Number.isFinite(ms)) throw new Error(`home.utc: ${String(when)} is not a date-time`);
    return new Date(ms).toISOString().replace('.000Z', 'Z');
  },
  /** An instant plus whole minutes, e.g. a `stale_after`. */
  plusMinutes: (instant: string, minutes: number): string => home.utc(Date.parse(instant) + minutes * 60_000),
  /** Major units (12.5, '12.50') to integer minor units in the currency's own digits. */
  money: (amount: number | string, currency: string): Money => ({ minor: toMinor(amount, currency), currency: currency.toUpperCase() }),
  /**
   * Total rows per currency, summed in minor units so 0.1 + 0.2 stays exact.
   * `total` is in major units, ready for `home.money`. A row whose amount is
   * not a number is skipped, never counted as zero.
   */
  sumByCurrency<T>(rows: T[], amountField: keyof T, currencyField: keyof T): Array<{ currency: string; total: number; minor: number; count: number }> {
    const by = new Map<string, { minor: number; count: number }>();
    for (const row of rows) {
      const currency = String(row[currencyField] ?? '').toUpperCase();
      const amount = Number(row[amountField]);
      if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(amount)) continue;
      const cur = by.get(currency) ?? { minor: 0, count: 0 };
      cur.minor += toMinor(amount, currency);
      cur.count += 1;
      by.set(currency, cur);
    }
    return [...by.entries()].map(([currency, c]) => ({ currency, minor: c.minor, count: c.count, total: c.minor / 10 ** minorDigits(currency) }));
  },
  /** Join keys. The platform hashes them; they are never shown. */
  subject: {
    email: (email: string): Subject => ({ key: 'email', value: email.trim().toLowerCase() }),
    /** An ABN with its spaces removed: the platform takes exactly 11 digits. */
    abn: (abn: string): Subject => ({ key: 'abn', value: abn.replace(/\s+/g, '') }),
    /** A `*_ref` minted by an app, paired with that app's slug. */
    ref: (key: 'order_ref' | 'customer_ref' | 'invoice_ref' | 'job_ref', value: string, issuer: string): Subject => ({ key, value, issuer }),
  },
} as const;

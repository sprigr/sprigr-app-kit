/**
 * The Home conformance suite (FINAL-APP-FEEDS section 12): drives an app's
 * Home tool the way the platform does, through `fakeHome`, and checks the
 * promises a type checker cannot see.
 *
 * Per provider in the manifest's `home` block (and its identity provider):
 *  - the answer is valid and echoes the request's basis, for two requests
 *    either side of local midnight in Australia/Brisbane (a 23:30 request is
 *    still that day; the next one starts at 14:00Z);
 *  - a `per_user` provider refuses a call with no actor, and one with an
 *    agent-only actor, as `no_caller_identity`;
 *  - a `company` provider answers with no actor;
 *  - two people never see each other's records;
 *  - every answer is under 64 KB, and arrives inside the time budget
 *    (default 2 s) unless it is `rate_limited`.
 * Across the run:
 *  - no D1 binding in the env runs a write (the binding is wrapped, not faked);
 *  - `env.SPRIGR` is called only for the reads a Home dispatch allows.
 *
 * The env is built ONCE (`opts.env()`), and the same env reaches every call.
 */

import { fakeHome, type AnyHomeTool, type FakeHome, type FakeHomeCall } from '@sprigr/apps-home/testing';
import type { HomeRequest } from '@sprigr/apps-home';
import { CheckCollector, type ConformanceReport } from './report';
import { isD1Like, readOnlySprigr, trackD1, type D1Tracker, type SprigrTracker } from './tracking';

export interface HomeConformanceActor {
  platformUserId?: string;
  agentId?: string;
  role?: string;
}

export interface HomeConformanceOptions<Env> {
  /** The parsed `sprigr-app.json`. */
  manifest: unknown;
  /** The app's Home tool (`homeTool(...)`, or a hand-written one). */
  tool: AnyHomeTool<Env>;
  /** Built ONCE per run; the same env reaches every call. */
  env: () => Env;
  /**
   * Two people, each connected to a vendor account of their own in `env` and
   * each with records, for the isolation check. Default two fixed ids.
   */
  actors?: [HomeConformanceActor, HomeConformanceActor];
  /** The vendor person id put on a request that needs one, by `platformUserId`. Default person_a / person_b. */
  people?: Record<string, string>;
  /** An answer slower than this must be `rate_limited`. Default 2000 ms. */
  timeBudgetMs?: number;
  /** The viewer's local day. Default 2026-10-07. */
  day?: string;
}

export const DEFAULT_CONFORMANCE_ACTORS: [HomeConformanceActor, HomeConformanceActor] = [
  { platformUserId: 'usr_conformance_a' },
  { platformUserId: 'usr_conformance_b' },
];

/** The largest answer the platform keeps (FINAL-APP-FEEDS section 12). */
export const HOME_MAX_ANSWER_BYTES = 64 * 1024;
const TZ = 'Australia/Brisbane';

interface Timed {
  call: FakeHomeCall | null;
  ms: number;
  timedOut: boolean;
  bytes: number;
  error?: string;
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export async function runHomeConformance<Env>(opts: HomeConformanceOptions<Env>): Promise<ConformanceReport> {
  const out = new CheckCollector();
  let h: FakeHome;
  try {
    h = fakeHome(opts.manifest);
    out.add('manifest.home_block', true, `${h.block.provides.length} provider(s)${h.block.identity ? ' and an identity provider' : ''}`);
  } catch (err) {
    out.add('manifest.home_block', false, err instanceof Error ? err.message : String(err));
    return out.report();
  }

  // One env, with its D1 bindings and env.SPRIGR wrapped to see writes.
  const raw = opts.env() as unknown;
  const d1: Array<{ key: string; t: D1Tracker<object> }> = [];
  let sprigr: SprigrTracker<object> | null = null;
  let env = raw as Env;
  if (raw && typeof raw === 'object') {
    const wrapped: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const [key, value] of Object.entries(wrapped)) {
      if (isD1Like(value)) {
        const t = trackD1(value as object);
        d1.push({ key, t });
        wrapped[key] = t.db;
      } else if (key === 'SPRIGR' && value && typeof value === 'object') {
        sprigr = readOnlySprigr(value as object);
        wrapped[key] = sprigr.sprigr;
      }
    }
    env = wrapped as Env;
  }

  const budget = opts.timeBudgetMs ?? 2000;
  const hangMs = Math.max(budget * 5, budget + 2000);
  const actors = opts.actors ?? DEFAULT_CONFORMANCE_ACTORS;
  const day = opts.day ?? '2026-10-07';
  const personFor = (a: HomeConformanceActor, i: number) =>
    (a.platformUserId && opts.people?.[a.platformUserId]) || (i === 0 ? 'person_a' : 'person_b');

  async function timedCall(provider: string, request: HomeRequest, actor: HomeConformanceActor | null): Promise<Timed> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only a hang guard, so a slow call that ends in rate_limited still reports
    // its answer: the budget itself is judged from `ms` below.
    const timeout = new Promise<'__budget__'>((resolve) => { timer = setTimeout(() => resolve('__budget__'), hangMs); });
    try {
      const raced = await Promise.race([
        h.call(opts.tool, provider, { env, request, actor: actor as never }).then((call) => ({ call }), (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
        timeout,
      ]);
      const ms = Date.now() - started;
      if (raced === '__budget__') return { call: null, ms, timedOut: true, bytes: 0 };
      if ('error' in raced) return { call: null, ms, timedOut: false, bytes: 0, error: raced.error };
      const bytes = new TextEncoder().encode(JSON.stringify(raced.call.outcome)).length;
      return { call: raced.call, ms, timedOut: false, bytes };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const providers = [
    ...h.block.provides.map((p) => ({ id: p.id, audience: p.audience, needsPerson: !!p.requires_person || p.scope === 'me' })),
    ...(h.block.identity ? [{ id: h.block.identity.provider, audience: 'per_user' as const, needsPerson: false }] : []),
  ];

  for (const p of providers) {
    const timings: Timed[] = [];
    const reqFor = (d: string, actorIndex: number) => {
      const req = h.request(p.id, { day: d, tz: TZ });
      if (p.needsPerson) req.person = { vendor_person_id: personFor(actors[actorIndex]!, actorIndex), method: 'native' };
      return req;
    };
    const viewer = p.audience === 'per_user' ? actors[0] : null;

    // Envelope and basis, either side of local midnight.
    const echoProblems: string[] = [];
    for (const d of [day, nextDay(day)]) {
      const req = reqFor(d, 0);
      const t = await timedCall(p.id, req, viewer);
      timings.push(t);
      if (t.timedOut) { echoProblems.push(`${d}: no answer within ${hangMs} ms`); continue; }
      if (t.error) { echoProblems.push(`${d}: threw ${t.error}`); continue; }
      const c = t.call!;
      if (!c.answer) { echoProblems.push(`${d}: refused (${c.problems.join('; ')})`); continue; }
      if (c.problems.length > 0) echoProblems.push(`${d}: ${c.problems.join('; ')}`);
      const b = c.answer.basis as { day?: unknown; tz?: unknown } | undefined;
      if (b?.day !== d || b?.tz !== TZ) echoProblems.push(`${d}: basis ${JSON.stringify(b)} is not the request's {day:"${d}",tz:"${TZ}"}`);
    }
    out.add(`${p.id}.envelope_and_basis`, echoProblems.length === 0,
      echoProblems.length === 0 ? `valid, basis echoed for ${day} and ${nextDay(day)} in ${TZ}` : echoProblems.join(' | '));

    if (p.audience === 'per_user') {
      for (const [name, actor] of [['refuses_no_actor', null], ['refuses_agent_only_actor', { agentId: 'agt_conformance' }]] as const) {
        const t = await timedCall(p.id, reqFor(day, 0), actor);
        timings.push(t);
        const c = t.call;
        const refused = !!c && !c.outcome.ok && /no_caller_identity/.test(c.outcome.error);
        out.add(`${p.id}.${name}`, refused, refused
          ? 'refused as no_caller_identity'
          : c?.answer ? `answered (state ${c.answer.state}) instead of refusing` : t.error ? `threw ${t.error}` : `refused, but not as no_caller_identity: ${c?.problems.join('; ') ?? 'timed out'}`);
      }

      // Isolation: two people, each with records of their own.
      const a = await timedCall(p.id, reqFor(day, 0), actors[0]);
      const b = await timedCall(p.id, reqFor(day, 1), actors[1]);
      timings.push(a, b);
      const ra = a.call?.answer?.records ?? [];
      const rb = b.call?.answer?.records ?? [];
      if (ra.length === 0 || rb.length === 0) {
        out.add(`${p.id}.actor_isolation`, false,
          `could not exercise it: actor ${ra.length === 0 ? 'A' : 'B'} got no records. Supply an env where both actors (${actors.map((x) => x.platformUserId).join(', ')}) are connected to vendor accounts of their own, each with records`);
      } else {
        const seenA = new Set(ra.map((r) => JSON.stringify(r)));
        const shared = rb.filter((r) => seenA.has(JSON.stringify(r)));
        out.add(`${p.id}.actor_isolation`, shared.length === 0, shared.length === 0
          ? `A got ${ra.length} record(s), B got ${rb.length}, none shared`
          : `${shared.length} record(s) reached both people, e.g. ${JSON.stringify(shared[0]).slice(0, 160)}`);
      }
    } else {
      const t = await timedCall(p.id, reqFor(day, 0), null);
      timings.push(t);
      const c = t.call;
      const ok = !!c?.answer && c.problems.length === 0;
      out.add(`${p.id}.answers_without_actor`, ok, ok ? `answered (state ${c!.answer!.state})` : `did not answer a company read: ${c?.problems.join('; ') ?? t.error ?? 'timed out'}`);
    }

    const big = timings.filter((t) => t.bytes > HOME_MAX_ANSWER_BYTES);
    out.add(`${p.id}.body_under_64kb`, big.length === 0, big.length === 0
      ? `largest ${Math.max(0, ...timings.map((t) => t.bytes))} bytes`
      : `${big.length} answer(s) over 64 KB, largest ${Math.max(...big.map((t) => t.bytes))} bytes`);

    const slow = timings.filter((t) => t.timedOut || (t.ms > budget && t.call?.answer?.state !== 'rate_limited'));
    out.add(`${p.id}.under_budget_or_rate_limited`, slow.length === 0, slow.length === 0
      ? `slowest ${Math.max(0, ...timings.map((t) => t.ms))} ms of ${budget}`
      : `${slow.length} call(s) over ${budget} ms without rate_limited, slowest ${Math.max(...slow.map((t) => t.ms))} ms`);
  }

  const writes = d1.flatMap(({ key, t }) => t.writes.map((w) => `${key}: ${w}`));
  out.add('env.no_d1_writes', writes.length === 0, d1.length === 0
    ? 'no D1 binding in the env'
    : writes.length === 0 ? `no writes on ${d1.map((x) => x.key).join(', ')}` : `${writes.length} write(s): ${writes.slice(0, 3).join(' | ')}`);
  out.add('env.sprigr_reads_only', !sprigr || sprigr.refused.length === 0, !sprigr
    ? 'no env.SPRIGR in the env'
    : sprigr.refused.length === 0 ? 'only the reads a Home dispatch allows' : `called ${[...new Set(sprigr.refused)].join(', ')}, which a Home dispatch refuses`);

  return out.report();
}

/**
 * The Home conformance suite against a conforming app, then against one
 * misbehaving app per rule: each must fail the check for its rule, by name.
 */

import { describe, it, expect } from 'vitest';
import { home, homeTool, identity, metrics, schedule, type HomeRequest, type HomeResult, type ScheduleRecord } from '@sprigr/apps-home';
import { fakeSprigrData } from '@sprigr/apps-home/testing';
import { formatReport, runHomeConformance, type ConformanceReport } from '../src/index';

const A = 'usr_conformance_a';
const B = 'usr_conformance_b';

const MANIFEST = {
  sprigr_app: { version: '1' },
  metadata: { name: 'Acme', slug: 'acme', version: '1.0.0', description: 'Acme jobs', author: { name: 'Acme' } },
  runtime: { entry: 'index.js' },
  permissions: { scopes: ['tools:register'] },
  tools: [{
    name: 'get_acme_home', internal: true, handler: 'src/handlers/home.ts',
    description: 'Platform-only: answers Sprigr Home contracts for one provider id',
    input_schema: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
  }],
  home: {
    tool: 'get_acme_home',
    identity: { contract: 'sprigr/home_identity', version: '^1.0', provider: 'whoami', methods: ['native'] },
    rate: { group: 'acme', max_dispatches_per_minute: 30 },
    provides: [
      { id: 'my_day', contract: 'sprigr/home_schedule', version: '^1.0', scope: 'me', audience: 'per_user', roles: ['owner', 'admin', 'manager', 'member'], requires_person: true, ttl_seconds: 900, fixtures: 'home/fixtures/my_day.json' },
      { id: 'money', contract: 'sprigr/home_metrics', version: '^1.0', scope: 'company', audience: 'company', roles: ['owner', 'admin'], metrics: ['receivables.overdue'], ttl_seconds: 1800, fixtures: 'home/fixtures/money.json' },
    ],
  },
};

function job(owner: string, n: number, extra: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: `${owner}-${n}`, kind: 'block', start: '2026-10-06T23:30:00Z', end: '2026-10-07T01:00:00Z',
    status: 'scheduled', category: 'job', title: `Job ${n}`, ref: { id: `${owner}-${n}` }, ...extra,
  };
}

/** A D1 stand-in: answers reads, runs writes, records nothing itself. */
function fakeD1() {
  const stmt = (sql: string) => ({
    sql,
    bind(..._args: unknown[]) { return this; },
    async all() { return { results: [], success: true }; },
    async first() { return null; },
    async run() { return { success: true }; },
    async raw() { return []; },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true })); },
    async exec() { return { count: 0 }; },
  };
}

type Env = {
  DB: ReturnType<typeof fakeD1>;
  SPRIGR: { data: ReturnType<typeof fakeSprigrData> };
  jobs: Record<string, ScheduleRecord[]>;
};

const envFor = (): Env => ({
  DB: fakeD1(),
  SPRIGR: { data: fakeSprigrData([{ objectID: 'inv-1', amountDue: 12.5, currencyCode: 'AUD' }]) },
  jobs: { [A]: [job('a', 1), job('a', 2)], [B]: [job('b', 1)] },
});

/** A correct app: each person sees only their own jobs; one company metric for everyone. */
const conforming = homeTool<Env>({
  whoami: identity(async (_env, actor) =>
    home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId === A ? 'person_a' : 'person_b', display_name: 'Sam' } })),
  my_day: schedule(async (env, actor, req) => {
    await env.DB.prepare('SELECT * FROM tokens WHERE actor_key = ?').bind(actor.platformUserId).first();
    return home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: env.jobs[actor.platformUserId!] ?? [] });
  }),
  money: metrics(async (env, req) => {
    const res = await env.SPRIGR.data.search({ hitsPerPage: 100 });
    const [aud] = home.sumByCurrency(res.hits, 'amountDue', 'currencyCode');
    return home.ok(req, {
      as_of: '2026-10-06T21:02:00Z',
      records: [{ metric: 'receivables.overdue', value: { kind: 'money', amount: home.money(aud!.total, aud!.currency) }, count: aud!.count, period: { kind: 'instant' } }],
    });
  }, { audience: 'company' }),
});

const failed = (r: ConformanceReport) => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

describe('runHomeConformance', () => {
  it('passes a conforming app on every check', async () => {
    const report = await runHomeConformance({ manifest: MANIFEST, tool: conforming, env: envFor });
    expect(failed(report), formatReport(report)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      'manifest.home_block',
      'my_day.envelope_and_basis', 'my_day.refuses_no_actor', 'my_day.refuses_agent_only_actor', 'my_day.actor_isolation',
      'my_day.body_under_64kb', 'my_day.under_budget_or_rate_limited',
      'money.envelope_and_basis', 'money.answers_without_actor',
      'whoami.envelope_and_basis', 'whoami.refuses_no_actor', 'whoami.actor_isolation',
      'env.no_d1_writes', 'env.sprigr_reads_only',
    ]));
  });

  it('fails isolation when one person sees another\'s records', async () => {
    const leaky = homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (env, _actor, req) => home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [...env.jobs[A]!, ...env.jobs[B]!] })),
      money: metrics(async (_e, req) => home.empty(req), { audience: 'company' }),
    });
    const report = await runHomeConformance({ manifest: MANIFEST, tool: leaky, env: envFor });
    expect(failed(report)).toEqual(['my_day.actor_isolation']);
  });

  it('fails isolation as not exercised when a person has no records, saying what to supply', async () => {
    const report = await runHomeConformance({ manifest: MANIFEST, tool: conforming, env: () => ({ ...envFor(), jobs: { [A]: [job('a', 1)] } }) });
    const check = report.checks.find((c) => c.name === 'my_day.actor_isolation')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/could not exercise it.*Supply an env/);
  });

  it('fails the person rule for a hand-written tool that answers anyone', async () => {
    const careless = async (args: { _home?: unknown }) => {
      const req = args._home as HomeRequest;
      if (req.contract === 'sprigr/home_identity') return home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: [{ connection: 'personal' as const }] });
      return home.empty(req);
    };
    const report = await runHomeConformance({ manifest: MANIFEST, tool: careless, env: envFor });
    expect(failed(report)).toEqual(expect.arrayContaining([
      'my_day.refuses_no_actor', 'my_day.refuses_agent_only_actor', 'whoami.refuses_no_actor', 'whoami.refuses_agent_only_actor',
    ]));
  });

  it('fails the basis check for a tool that answers for the UTC day', async () => {
    const utcDay = async (args: { _home?: unknown; actor?: unknown }) => {
      const req = args._home as HomeRequest;
      const person = (args.actor as { platformUserId?: string } | undefined)?.platformUserId;
      if (!person && req.contract !== 'sprigr/home_metrics') return { ok: false, error: 'no_caller_identity' };
      const answer: HomeResult<never> = { ...home.empty(req), basis: { day: req.basis.window_start.slice(0, 10), tz: 'UTC' } };
      return answer;
    };
    const report = await runHomeConformance({ manifest: MANIFEST, tool: utcDay, env: envFor });
    const check = report.checks.find((c) => c.name === 'my_day.envelope_and_basis')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/basis .* is not the request's/);
  });

  it('fails when a company provider will not answer without an actor', async () => {
    const strict = homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (env, actor, req) => home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: env.jobs[actor.platformUserId!] ?? [] })),
      money: metrics(async (_e, _a, req) => home.empty(req)),
    });
    const report = await runHomeConformance({ manifest: MANIFEST, tool: strict, env: envFor });
    expect(failed(report)).toEqual(expect.arrayContaining(['money.answers_without_actor']));
  });

  it('fails when a Home read writes to D1, naming the statement', async () => {
    const writer = homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (env, actor, req) => {
        await env.DB.prepare('INSERT INTO seen (actor) VALUES (?)').bind(actor.platformUserId).run();
        return home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: env.jobs[actor.platformUserId!] ?? [] });
      }),
      money: metrics(async (_e, req) => home.empty(req), { audience: 'company' }),
    });
    const report = await runHomeConformance({ manifest: MANIFEST, tool: writer, env: envFor });
    expect(failed(report)).toEqual(['env.no_d1_writes']);
    expect(report.checks.find((c) => c.name === 'env.no_d1_writes')!.detail).toMatch(/DB: INSERT INTO seen/);
  });

  it('fails when a Home read calls an env.SPRIGR write', async () => {
    const importer = homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (env, actor, req) => home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: env.jobs[actor.platformUserId!] ?? [] })),
      money: metrics(async (env, req) => {
        await env.SPRIGR.data.import([{ objectID: 'x' }]).catch(() => undefined);
        return home.empty(req);
      }, { audience: 'company' }),
    });
    const report = await runHomeConformance({ manifest: MANIFEST, tool: importer, env: envFor });
    expect(failed(report)).toEqual(['env.sprigr_reads_only']);
    expect(report.checks.find((c) => c.name === 'env.sprigr_reads_only')!.detail).toMatch(/data\.import/);
  });

  it('fails an answer over 64 KB', async () => {
    const huge = homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (_env, actor, req) => home.ok(req, {
        as_of: '2026-10-06T21:02:00Z',
        records: Array.from({ length: 200 }, (_, i) => job(actor.platformUserId!, i, { location: { text: 'x'.repeat(160) }, title: 'y'.repeat(80) })),
      })),
      money: metrics(async (_e, req) => home.empty(req), { audience: 'company' }),
    });
    const report = await runHomeConformance({ manifest: MANIFEST, tool: huge, env: envFor });
    expect(failed(report)).toContain('my_day.body_under_64kb');
  });

  it('fails a slow answer, but not a slow rate_limited one', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = (limited: boolean) => homeTool<Env>({
      whoami: identity(async (_e, actor) => home.identity({ connection: 'personal', native_person: { vendor_person_id: actor.platformUserId!, display_name: 'Sam' } })),
      my_day: schedule(async (env, actor, req) => {
        await sleep(80);
        return limited ? home.rateLimited(req, 30) : home.ok(req, { as_of: '2026-10-06T21:02:00Z', records: env.jobs[actor.platformUserId!] ?? [] });
      }),
      money: metrics(async (_e, req) => home.empty(req), { audience: 'company' }),
    });
    const tooSlow = await runHomeConformance({ manifest: MANIFEST, tool: slow(false), env: envFor, timeBudgetMs: 40 });
    expect(failed(tooSlow)).toContain('my_day.under_budget_or_rate_limited');
    const limited = await runHomeConformance({ manifest: MANIFEST, tool: slow(true), env: envFor, timeBudgetMs: 40 });
    expect(failed(limited)).not.toContain('my_day.under_budget_or_rate_limited');
  });

  it('stops at a home block the platform would refuse', async () => {
    const report = await runHomeConformance({ manifest: { ...MANIFEST, home: { ...MANIFEST.home, tool: 'get_other_home' } }, tool: conforming, env: envFor });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: 'manifest.home_block', ok: false });
  });
});

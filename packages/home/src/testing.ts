/**
 * `@sprigr/apps-home/testing`: run an app's Home tool the way the platform
 * does, and check every answer with the platform's own rules (FINAL-APP-FEEDS
 * section 12). Mirrors `@sprigr/apps-datasets/testing`'s `fakeDatasets`.
 *
 *   import { fakeHome, fakeSprigrData } from '@sprigr/apps-home/testing';
 *   import manifest from '../sprigr-app.json';
 *
 *   const h = fakeHome(manifest, { readFile: (p) => readFileSync(join(appDir, p), 'utf8') });
 *   const runs = await h.runFixtures(get_my_app_home, { env: (c) => envFor(c.vendor) });
 *   for (const r of runs) expect(r.problems, r.case).toEqual([]);
 *
 * Nothing here talks to the platform. `fakeSprigrData(rows)` stands in for
 * `env.SPRIGR.data` (which `sprigr app dev` does not provide) and, like a
 * real Home dispatch (sprigr-team decision 0177), refuses every write.
 */

import type { Actor, ToolResult } from '@sprigr/apps-app-sdk';
import { validateHomeFixtures } from './fixtures';
import { homeBlockFromManifest, type HomeValidationDeps } from './manifest';
import { checkHomeAnswer, homeRequestProblems } from './records';
import type { HomeToolHandler } from './sdk';
import type { HomeBlock, HomeFixtureCase, HomeProviderDeclaration, HomeRequest, HomeResult } from './types';
import { HOME_APP_DEADLINE_MS, HOME_CONTRACT_SERVED_VERSIONS, type HomeContractId } from './vocabulary';

/**
 * Stand-in for the platform's dispatch-tier classifier, as this package's own
 * tests use it: a Home tool must read as a read (`get_...`) and must not
 * declare write effects. The platform's classifier lives in sprigr-team.
 */
const READ_SHAPED: HomeValidationDeps = {
  isReadShapedDispatch: (name, effects) => effects !== 'write' && /^(get|list|search)_/.test(name),
};

/** The viewer stamped on a person's provider when a test does not name one. */
export const FAKE_HOME_VIEWER: Actor = { platformUserId: 'usr_fake_home_viewer' };

export interface FakeHomeOptions {
  /** Read a file the manifest names (a fixtures file), relative to the app. Needed by `runFixtures`. */
  readFile?: (path: string) => string | undefined;
  /** The viewer stamped on a person's provider. Default `FAKE_HOME_VIEWER`. */
  actor?: Actor;
}

export interface FakeHomeCall {
  provider: string;
  request: HomeRequest;
  /** What the tool returned. */
  outcome: ToolResult<HomeResult<unknown>>;
  /** The answer, when the tool returned one. */
  answer: HomeResult<unknown> | null;
  /**
   * Every problem the platform would have with this call: the request (a
   * test that built a bad one), a tool error, and the answer as a whole. An
   * answer-level problem makes the platform treat the answer as `error`.
   */
  problems: string[];
  /** Records the platform would drop one by one (never drawn, never cached). */
  dropped: Array<{ index: number; problems: string[] }>;
}

export interface FakeHomeFixtureRun extends FakeHomeCall {
  /** The fixture case name. */
  case: string;
  /** The answer equals the case's `expect`, exactly. */
  matchesExpect: boolean;
  /** Top-level fields that differ from `expect`, e.g. `records`, `state`. */
  expectDiff: string[];
}

export interface FakeHome {
  /** The validated `home` block. */
  readonly block: HomeBlock;
  /** Every call made through this fake, in order. */
  readonly calls: FakeHomeCall[];
  /** A request the platform would send this provider (or the identity provider). */
  request(provider: string, overrides?: FakeHomeRequestOverrides): HomeRequest;
  /** Dispatch one provider through the tool, as the platform's wrapper would, and check the answer. */
  call<Env>(tool: HomeToolHandler<Env>, provider: string, opts: { env: Env; request?: HomeRequest; actor?: Actor | null }): Promise<FakeHomeCall>;
  /** Run every case of every provider's fixtures file through the tool. */
  runFixtures<Env>(tool: HomeToolHandler<Env>, opts: { env: (c: HomeFixtureCase) => Env; actor?: Actor }): Promise<FakeHomeFixtureRun[]>;
}

export interface FakeHomeRequestOverrides extends Partial<Omit<HomeRequest, 'basis'>> {
  /** The viewer's local day. Default 2026-10-07. */
  day?: string;
  /** The viewer's zone. Default Australia/Brisbane. */
  tz?: string;
}

/**
 * A fake Home for one app. Throws when the manifest has no valid `home` block,
 * naming the problem, just as the platform refuses it at publish.
 */
export function fakeHome(manifest: unknown, opts: FakeHomeOptions = {}): FakeHome {
  let refusal = 'the manifest has no home block';
  const block = homeBlockFromManifest(manifest, READ_SHAPED, (m) => { refusal = m; });
  if (!block) throw new Error(`fakeHome: ${refusal}`);
  const linkIds = (block.links ?? []).map((l) => l.id);
  const calls: FakeHomeCall[] = [];

  function declaration(provider: string): { contract: HomeContractId; decl?: HomeProviderDeclaration } {
    const decl = block!.provides.find((p) => p.id === provider);
    if (decl) return { contract: decl.contract, decl };
    if (block!.identity?.provider === provider) return { contract: 'sprigr/home_identity' };
    throw new Error(`fakeHome: no provider ${provider} in the home block`);
  }

  function request(provider: string, o: FakeHomeRequestOverrides = {}): HomeRequest {
    const { contract, decl } = declaration(provider);
    const day = o.day ?? '2026-10-07';
    const tz = o.tz ?? 'Australia/Brisbane';
    const { day: _d, tz: _t, ...rest } = o;
    const isIdentity = contract === 'sprigr/home_identity';
    const needsPerson = !isIdentity && (decl?.requires_person || decl?.scope === 'me');
    return {
      contract,
      version: latestServed(contract),
      provider,
      scope: isIdentity ? 'me' : decl!.scope,
      basis: { day, tz, ...localDayWindow(day, tz) },
      ...(needsPerson ? { person: { vendor_person_id: 'person_1', method: 'native' as const } } : {}),
      purpose: isIdentity ? 'identity' : 'read',
      deadline_ms: HOME_APP_DEADLINE_MS,
      ...rest,
    } as HomeRequest;
  }

  async function call<Env>(
    tool: HomeToolHandler<Env>,
    provider: string,
    o: { env: Env; request?: HomeRequest; actor?: Actor | null },
  ): Promise<FakeHomeCall> {
    const { contract, decl } = declaration(provider);
    const req = o.request ?? request(provider);
    const problems = homeRequestProblems(req).map((p) => `request: ${p}`);
    const actor = o.actor === undefined ? opts.actor ?? FAKE_HOME_VIEWER : o.actor;
    // The wrapper's shape on a Home dispatch: the body is { provider }, and it
    // adds `_home` and `actor` from platform headers.
    const args = { provider, _home: req, ...(actor ? { actor } : {}) };
    const outcome = await tool(args, o.env);
    let answer: HomeResult<unknown> | null = null;
    let dropped: FakeHomeCall['dropped'] = [];
    if (outcome.ok) {
      answer = outcome.result;
      const check = checkHomeAnswer(contract, answer, { request: req, provider: decl, linkIds });
      problems.push(...check.problems);
      dropped = check.dropped;
    } else {
      problems.push(`tool: ${outcome.error}${outcome.hint ? ` (${outcome.hint})` : ''}`);
    }
    const out: FakeHomeCall = { provider, request: req, outcome, answer, problems, dropped };
    calls.push(out);
    return out;
  }

  async function runFixtures<Env>(
    tool: HomeToolHandler<Env>,
    o: { env: (c: HomeFixtureCase) => Env; actor?: Actor },
  ): Promise<FakeHomeFixtureRun[]> {
    const readFile = opts.readFile;
    if (!readFile) throw new Error('fakeHome: runFixtures needs options.readFile to read the fixtures files');
    const fixturesProblem = validateHomeFixtures(block!, readFile);
    if (fixturesProblem) throw new Error(`fakeHome: ${fixturesProblem}`);
    const runs: FakeHomeFixtureRun[] = [];
    for (const decl of block!.provides) {
      const cases = JSON.parse(readFile(decl.fixtures) ?? '[]') as HomeFixtureCase[];
      for (const c of cases) {
        const r = await call(tool, decl.id, { env: o.env(c), request: c.request, actor: o.actor });
        const expectDiff = r.answer ? topLevelDiff(r.answer, c.expect) : ['(no answer)'];
        runs.push({ ...r, case: c.name, matchesExpect: expectDiff.length === 0, expectDiff });
      }
    }
    return runs;
  }

  return { block, calls, request, call, runFixtures };
}

function latestServed(contract: HomeContractId): string {
  const versions = [...HOME_CONTRACT_SERVED_VERSIONS[contract]];
  return versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return (pa[0]! - pb[0]!) || (pa[1]! - pb[1]!) || (pa[2]! - pb[2]!);
  })[versions.length - 1]!;
}

/** UTC offset of `tz` at `ms`, in minutes east of UTC. */
function offsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - ms) / 60_000);
}

/** The UTC instant of local midnight on `day` in `tz`, DST-aware. */
function localMidnight(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  let ms = naive - offsetMinutes(naive, tz) * 60_000;
  ms = naive - offsetMinutes(ms, tz) * 60_000;
  return ms;
}

/** The platform's window: local midnight to the next local midnight, as UTC `Z` instants. */
function localDayWindow(day: string, tz: string): { window_start: string; window_end: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const z = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  return { window_start: z(localMidnight(day, tz)), window_end: z(localMidnight(next, tz)) };
}

function topLevelDiff(a: object, b: object): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) out.push(k);
  }
  return out.sort();
}

// ─── env.SPRIGR.data ───────────────────────────────────────────────────────

type Row = { objectID: string; [key: string]: unknown };

export interface FakeSprigrDataSearchOpts {
  query?: string;
  /** `field:value` terms joined by commas, all required (equality on the field's string form). */
  filters?: string;
  /** `field:asc` or `field:desc`. */
  sortBy?: string;
  page?: number;
  hitsPerPage?: number;
  attributesToRetrieve?: string[];
  index?: string;
}

/** A read-only `env.SPRIGR.data` over fixed rows. */
export interface FakeSprigrData {
  search(opts?: FakeSprigrDataSearchOpts): Promise<{ ok: true; hits: Row[]; nbHits: number; page: number; index: string }>;
  get(objectID: string, opts?: { index?: string }): Promise<{ ok: true; object: Row | null; index: string }>;
  listIds(prefix: string, opts?: { index?: string }): Promise<{ objectIDs: string[]; total: number; truncated: false }>;
  /** Writes refuse with `err.code === 'home_read_only'`, as a Home dispatch's `env.SPRIGR` does. */
  import(...args: unknown[]): Promise<never>;
  partialUpdate(...args: unknown[]): Promise<never>;
  delete(...args: unknown[]): Promise<never>;
  /** Every read, in order. */
  readonly reads: Array<{ method: 'search' | 'get' | 'listIds'; index: string }>;
  /** Every refused write, in order. A Home tool should leave this empty. */
  readonly refusedWrites: string[];
}

/**
 * `rows` is one index (an array), or a map of logical index name to rows for
 * an app with `data_indexes`. With a map, a search must name an index the map
 * has, as the platform requires.
 */
export function fakeSprigrData(rows: Row[] | Record<string, Row[]>): FakeSprigrData {
  const reads: FakeSprigrData['reads'] = [];
  const refusedWrites: string[] = [];
  const DEFAULT = 'default';

  function rowsFor(index: string | undefined): { name: string; rows: Row[] } {
    if (Array.isArray(rows)) return { name: index ?? DEFAULT, rows };
    if (!index) throw new Error(`unknown_data_index: name one of ${Object.keys(rows).join(', ')}`);
    const r = rows[index];
    if (!r) throw new Error(`unknown_data_index: ${index}`);
    return { name: index, rows: r };
  }

  function refuse(method: string): Promise<never> {
    refusedWrites.push(method);
    const err = new Error(`home_read_only: data.${method} is not allowed on a Home dispatch`) as Error & { code: string };
    err.code = 'home_read_only';
    return Promise.reject(err);
  }

  return {
    reads,
    refusedWrites,
    async search(o = {}) {
      const { name, rows: all } = rowsFor(o.index);
      reads.push({ method: 'search', index: name });
      const terms = (o.filters ?? '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
        const i = t.indexOf(':');
        return [t.slice(0, i), t.slice(i + 1)] as const;
      });
      const q = (o.query ?? '').trim().toLowerCase();
      let hits = all.filter((r) => terms.every(([f, v]) => String(r[f]) === v))
        .filter((r) => !q || Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
      if (o.sortBy) {
        const [field, dir] = o.sortBy.split(':') as [string, string | undefined];
        const sign = dir === 'desc' ? -1 : 1;
        hits = [...hits].sort((a, b) => (String(a[field]) < String(b[field]) ? -sign : String(a[field]) > String(b[field]) ? sign : 0));
      }
      const per = Math.min(Math.max(o.hitsPerPage ?? 20, 1), 100);
      const page = Math.max(o.page ?? 0, 0);
      const pageHits = hits.slice(page * per, page * per + per).map((r) => {
        if (!o.attributesToRetrieve) return r;
        const out: Row = { objectID: r.objectID };
        for (const a of o.attributesToRetrieve) if (a in r) out[a] = r[a];
        return out;
      });
      return { ok: true, hits: pageHits, nbHits: hits.length, page, index: name };
    },
    async get(objectID, o = {}) {
      const { name, rows: all } = rowsFor(o.index);
      reads.push({ method: 'get', index: name });
      return { ok: true, object: all.find((r) => r.objectID === objectID) ?? null, index: name };
    },
    async listIds(prefix, o = {}) {
      const { name, rows: all } = rowsFor(o.index);
      reads.push({ method: 'listIds', index: name });
      const ids = all.map((r) => r.objectID).filter((id) => id.startsWith(prefix));
      return { objectIDs: ids, total: ids.length, truncated: false };
    },
    import: () => refuse('import'),
    partialUpdate: () => refuse('partialUpdate'),
    delete: () => refuse('delete'),
  };
}

/**
 * Where a scheduled tick's time goes (sprigr-team#13478, sprigr-apps#4093).
 *
 * A tick that runs past its budget logs which step was running at the
 * deadline, but not which call inside that step. This records, per call name,
 * how many calls ran, their total and slowest milliseconds, and how many
 * milliseconds ran past the tick's deadline. Names:
 *   - `step.*`  each step of the caller's loop (a step contains other calls);
 *   - `<prefix>.*`  the source adapter calls a pass makes (`timeAdapter`);
 *   - `files.*`, `data.*`, `acl.*`, `emit`  the platform calls a pass makes;
 *   - `d1.<verb>:<table>`, `d1.batch`  the install database (`withD1Timing`).
 * Calls that overlap (permission reads run concurrently) add up past wall
 * time, so `late` is the column to read: it is the part of each call after
 * the deadline. `open()` names the calls still running, for the late row.
 */

import { overlaySprigr } from '@sprigr/apps-app-sdk';

export interface CallStat {
  /** Calls made. */
  n: number;
  /** Total milliseconds across them. */
  ms: number;
  /** The slowest single call. */
  max: number;
  /** Milliseconds run past the deadline. */
  late: number;
}

export interface CallTiming {
  readonly calls: Record<string, CallStat>;
  /** Run `fn` as one call of `name`. */
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** The calls running now: name to how long the longest has been open. */
  open(): Record<string, number>;
  /** Per `step.*`, the ms of its wall time no timed call inside it was
   *  running (an open step counts so far). Time spent between calls (CPU,
   *  loops) or in a call the timer cannot see (sprigr-team#13150). */
  untimed(): Record<string, number>;
}

/** A loop step (`step.*`) holds other calls; every other name is a call. */
const isStep = (name: string): boolean => name.startsWith('step.');

export function newCallTiming(opts: { deadlineAt: number; now?: () => number }): CallTiming {
  const now = opts.now ?? Date.now;
  const calls: Record<string, CallStat> = {};
  const running = new Map<number, { name: string; start: number; coveredAtStart: number }>();
  const untimedDone: Record<string, number> = {};
  let seq = 0;
  // The union of the time any non-step call was running: concurrent calls
  // count once, so a step's untimed share is never below 0.
  let openCalls = 0;
  let coverStart = 0;
  let coveredDone = 0;
  const covered = (t: number): number => coveredDone + (openCalls > 0 ? t - coverStart : 0);
  const untimedOf = (r: { start: number; coveredAtStart: number }, t: number): number =>
    Math.max(0, t - r.start - (covered(t) - r.coveredAtStart));
  return {
    calls,
    async time(name, fn) {
      const id = ++seq;
      const start = now();
      const step = isStep(name);
      if (!step && openCalls++ === 0) coverStart = start;
      const entry = { name, start, coveredAtStart: covered(start) };
      running.set(id, entry);
      try {
        return await fn();
      } finally {
        running.delete(id);
        const end = now();
        if (step) untimedDone[name] = (untimedDone[name] ?? 0) + untimedOf(entry, end);
        else if (--openCalls === 0) coveredDone += end - coverStart;
        const ms = Math.max(0, end - start);
        const s = (calls[name] ??= { n: 0, ms: 0, max: 0, late: 0 });
        s.n++;
        s.ms += ms;
        s.max = Math.max(s.max, ms);
        s.late += Math.max(0, end - Math.max(start, opts.deadlineAt));
      }
    },
    open() {
      const t = now();
      const out: Record<string, number> = {};
      for (const { name, start } of running.values()) out[name] = Math.max(out[name] ?? 0, t - start);
      return out;
    },
    untimed() {
      const t = now();
      const out: Record<string, number> = { ...untimedDone };
      for (const r of running.values()) if (isStep(r.name)) out[r.name] = (out[r.name] ?? 0) + untimedOf(r, t);
      return out;
    },
  };
}

/** The FileSourceAdapter calls a pass makes that are worth timing.
 *  `runExclusive` wraps the whole pass, which the caller's step already times. */
export const ADAPTER_CALLS = [
  'seedCursor',
  'fullWalk',
  'listChanges',
  'resolvePrincipals',
  'refetchEntry',
  'downloadText',
  'downloadBinary',
  'exportNative',
  'extractJobToken',
  'deleteStaged',
  'extraScopes',
  'aclRefreshPage',
  'resolveOwnerEmail',
  'isConnected',
] as const;

/** A copy of `adapter` whose async calls are timed as `<prefix>.<name>`. A
 *  call the adapter does not have stays absent. */
export function timeAdapter<A extends object>(
  adapter: A,
  timing: CallTiming,
  prefix: string,
  calls: readonly string[] = ADAPTER_CALLS,
): A {
  const copy: Record<string, unknown> = { ...(adapter as Record<string, unknown>) };
  for (const name of calls) {
    const fn = copy[name];
    if (typeof fn !== 'function') continue;
    copy[name] = (...args: unknown[]) => timing.time(`${prefix}.${name}`, () => Promise.resolve((fn as (...a: unknown[]) => unknown).apply(adapter, args)));
  }
  return copy as A;
}

function timedMethods<T extends object>(target: T, prefix: string, timing: CallTiming): T {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== 'function') return v;
      const name = `${prefix}.${String(prop)}`;
      return (...args: unknown[]) => timing.time(name, () => Promise.resolve((v as (...a: unknown[]) => unknown).apply(t, args)));
    },
  });
}

/** The platform surface `withCallTiming` times; any other member passes through. */
interface TimedSprigr {
  files?: object;
  data?: object;
  emit?: (event: string, payload: unknown) => Promise<unknown>;
}

/** `env` with its platform files, data, acl and emit calls timed. `acl` is
 *  the pass's identity link (`acl.linkIdentity`, one per pass on a fresh
 *  isolate: sprigr-team#13478). */
export function withCallTiming<E extends object>(env: E, timing: CallTiming): E {
  const sprigr = (env as { SPRIGR?: TimedSprigr }).SPRIGR;
  if (!sprigr) return env;
  const emit = sprigr.emit;
  const acl = (sprigr as { acl?: object }).acl;
  return overlaySprigr(env, {
    ...sprigr,
    ...(sprigr.files ? { files: timedMethods(sprigr.files, 'files', timing) } : {}),
    ...(sprigr.data ? { data: timedMethods(sprigr.data, 'data', timing) } : {}),
    ...(acl ? { acl: timedMethods(acl, 'acl', timing) } : {}),
    ...(emit ? { emit: (event: string, payload: unknown) => timing.time('emit', () => emit.call(sprigr, event, payload)) } : {}),
  }) as E;
}

/** The table a statement works on: the first FROM, INTO or UPDATE target. */
function d1Table(sql: string): string {
  const m = /\b(?:from|into|update)\s+["`[]?([A-Za-z0-9_]+)/i.exec(sql);
  return m?.[1] ?? '?';
}

const D1_VERBS = new Set(['first', 'run', 'all', 'raw']);

/**
 * `env` with its D1 binding timed as `d1.<verb>:<table>`, plus `d1.batch`
 * (sprigr-team#13478: a 0-file pass spent 4.4 s the timer could not see, and
 * about eight D1 statements are in it). Apply it once, to the env the
 * adapter and the store are built from: they keep that env and run their own
 * queries on it (the lease, the row load), which a per-pass env built later
 * never reaches.
 *
 * `batch` gets the real statements back: D1 refuses objects it did not make.
 * D1 time inside an adapter call is counted under both names; `untimed()`
 * counts it once.
 */
export function withD1Timing<E extends object>(env: E, timing: CallTiming): E {
  const db = (env as { DB?: unknown }).DB as unknown as (object & { prepare(sql: string): object; batch?: (s: object[]) => Promise<unknown> }) | undefined;
  if (!db) return env;
  const realOf = new WeakMap<object, object>();
  const wrap = (stmt: object, table: string): object => {
    const proxy = new Proxy(stmt, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t) as unknown;
        if (typeof v !== 'function') return v;
        if (prop === 'bind') return (...args: unknown[]) => wrap((v as (...a: unknown[]) => object).apply(t, args), table);
        if (typeof prop === 'string' && D1_VERBS.has(prop)) {
          return (...args: unknown[]) => timing.time(`d1.${prop}:${table}`, () => Promise.resolve((v as (...a: unknown[]) => unknown).apply(t, args)));
        }
        return (v as (...a: unknown[]) => unknown).bind(t);
      },
    });
    realOf.set(proxy, stmt);
    return proxy;
  };
  const timedDb = new Proxy(db, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== 'function') return v;
      if (prop === 'prepare') return (sql: string) => wrap((v as (s: string) => object).call(t, sql), d1Table(sql));
      if (prop === 'batch') {
        return (stmts: object[]) => timing.time('d1.batch', () => Promise.resolve((v as (s: object[]) => unknown).call(t, stmts.map((s) => realOf.get(s) ?? s))));
      }
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  });
  const out = Object.create(env) as E;
  Object.defineProperty(out, 'DB', { value: timedDb, enumerable: true, configurable: false });
  return out;
}

/**
 * The calls for a row's metadata, most time first, within `maxChars` of JSON
 * (the row's metadata is cut at 3,840 characters, and a cut JSON reads as
 * nothing). Calls left out are counted in `_omitted`.
 */
export function callsForRow(calls: Record<string, CallStat>, maxChars = 1800): Record<string, CallStat | number> {
  const out: Record<string, CallStat | number> = {};
  const sorted = Object.entries(calls).sort((a, b) => b[1].late - a[1].late || b[1].ms - a[1].ms);
  let size = 2;
  let omitted = 0;
  for (const [name, stat] of sorted) {
    const add = JSON.stringify(name).length + JSON.stringify(stat).length + 2;
    if (size + add > maxChars) {
      omitted++;
      continue;
    }
    out[name] = stat;
    size += add;
  }
  if (omitted > 0) out._omitted = omitted;
  return out;
}

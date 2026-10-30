/**
 * A bounded, resumable sweep of an app's own stored files past their life.
 *
 * Several apps keep copies in env.SPRIGR.files that nothing reads once a link
 * to them has expired: read results offloaded because they were too big to
 * return inline, attachment copies, staged uploads. The platform never prunes
 * an app's store while the install lives, so each app needs a sweep. This is
 * the walk those sweeps share; the app supplies what is specific to it: which
 * keys are its to judge, when one has expired, and where the walk's state
 * lives between ticks.
 *
 * WALK. One `files.list(prefix, { cursor })` page at a time, prefix by prefix,
 * following the platform's cursor. A page's counts are merged only once the
 * whole page is judged, so a page cut short by the delete cap or the budget is
 * listed again next tick and never counted twice. The walk resumes from its
 * saved position until it is done; a finished walk starts again only when the
 * caller passes a new `walkId` (a UTC day, say). A mode change starts a fresh
 * walk, so report counts never mix with delete counts.
 *
 * FAIL CLOSED. A key is judged only when `classify` names it. Anything it
 * returns null for (a directory marker, a key in a shape the app never
 * writes) is counted as skipped and never deleted. An entry with no parseable
 * `uploaded` time is never expired.
 *
 * BOUNDS per tick: `maxListingsPerTick` listings and `maxDeletesPerTick`
 * deletes, each started only while `hasBudget()` says so and each waited on
 * for at most `callTimeoutMs`. Never throws: a failed listing or delete ends
 * the tick and the walk resumes from the same page next tick.
 */

export type FileSweepMode = 'report' | 'delete';

/** One entry of a `files.list` page, as the platform returns it. */
export interface SweepFileEntry {
  key?: unknown;
  bytes?: unknown;
  uploaded?: unknown;
  [field: string]: unknown;
}

/** The subset of env.SPRIGR.files a sweep calls. */
export interface SweepFilesApi {
  list(
    prefix: string,
    opts?: { cursor?: string },
  ): Promise<{ files?: SweepFileEntry[]; truncated?: boolean; cursor?: string | null } | null | undefined>;
  delete?(key: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface Tally {
  objects: number;
  bytes: number;
}

export interface FileSweepState {
  v: 1;
  mode: FileSweepMode;
  walk_id: string;
  started_at: number;
  prefix_index: number;
  cursor: string | null;
  /** Every judged entry, per kind. */
  seen: Record<string, Tally>;
  /** Entries past their life, per kind. */
  expired: Record<string, Tally>;
  /** delete mode: entries deleted, per kind. */
  deleted: Record<string, Tally>;
  /** Entries `classify` refused, so never judged or deleted. */
  skipped: Tally;
  /** Up to `sampleSize` expired keys, oldest walk order first. */
  samples: string[];
  listings: number;
  done_at: number | null;
}

export interface FileSweepStateStore {
  read(): Promise<string | null | undefined>;
  write(raw: string): Promise<void>;
}

export interface FileSweepOptions {
  files: SweepFilesApi;
  /** App-relative prefixes to walk, in order. */
  prefixes: readonly string[];
  /** The kind label for a key this sweep may judge, or null to leave it alone. */
  classify(key: string, prefix: string): string | null;
  /** True when an entry uploaded at `uploadedMs` is past its life at `startedAt`. */
  isExpired(uploadedMs: number, startedAt: number, kind: string): boolean;
  mode: FileSweepMode;
  /** Identifies a walk. A finished walk starts again only under a new id. */
  walkId: string;
  state: FileSweepStateStore;
  /** Extra fields for `files.delete`, per entry (an owner_ref, say). */
  deleteOptions?(entry: SweepFileEntry): Record<string, unknown> | undefined;
  /** Further entry filter, applied after `classify` (false = skipped). */
  accept?(entry: SweepFileEntry): boolean;
  now?: () => number;
  /** False once the caller's time budget is spent. Defaults to always true. */
  hasBudget?: () => boolean;
  maxListingsPerTick?: number;
  maxDeletesPerTick?: number;
  callTimeoutMs?: number;
  sampleSize?: number;
  /** Prefix for console warnings, e.g. "[github-offload-sweep]". */
  logTag?: string;
}

export interface FileSweepResult {
  /** The walk is finished (this tick or earlier). */
  done: boolean;
  /** The walk finished during this tick: the moment to log a summary. */
  finished_now: boolean;
  listings: number;
  deleted: number;
  /** The walk's state after this tick, or null when nothing could be read. */
  state: FileSweepState | null;
}

export const DEFAULT_MAX_LISTINGS_PER_TICK = 16;
export const DEFAULT_MAX_DELETES_PER_TICK = 200;
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
export const DEFAULT_SAMPLE_SIZE = 5;

export function emptyTally(): Tally {
  return { objects: 0, bytes: 0 };
}

export function addTally(into: Record<string, Tally>, name: string, bytes: number): void {
  const t = (into[name] ??= emptyTally());
  t.objects += 1;
  t.bytes += bytes;
}

export function totalOf(tallies: Record<string, Tally>): Tally {
  const out = emptyTally();
  for (const t of Object.values(tallies)) {
    out.objects += t.objects;
    out.bytes += t.bytes;
  }
  return out;
}

function mergeInto(into: Record<string, Tally>, from: Record<string, Tally>): void {
  for (const [name, t] of Object.entries(from)) {
    const d = (into[name] ??= emptyTally());
    d.objects += t.objects;
    d.bytes += t.bytes;
  }
}

function freshState(mode: FileSweepMode, walkId: string, now: number): FileSweepState {
  return {
    v: 1, mode, walk_id: walkId, started_at: now, prefix_index: 0, cursor: null,
    seen: {}, expired: {}, deleted: {}, skipped: emptyTally(), samples: [],
    listings: 0, done_at: null,
  };
}

/** The saved state, or null when there is none or it belongs to another mode. */
export function parseFileSweepState(raw: string | null | undefined, mode: FileSweepMode): FileSweepState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<FileSweepState>;
    if (s?.v !== 1 || s.mode !== mode || typeof s.walk_id !== 'string' || typeof s.prefix_index !== 'number') return null;
    return { ...freshState(mode, s.walk_id, typeof s.started_at === 'number' ? s.started_at : 0), ...s } as FileSweepState;
  } catch {
    return null;
  }
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Walk (or continue walking) the sweep within this tick's bounds. */
export async function runFileSweep(opts: FileSweepOptions): Promise<FileSweepResult> {
  const now = opts.now ?? Date.now;
  const hasBudget = opts.hasBudget ?? (() => true);
  const maxListings = opts.maxListingsPerTick ?? DEFAULT_MAX_LISTINGS_PER_TICK;
  const maxDeletes = opts.maxDeletesPerTick ?? DEFAULT_MAX_DELETES_PER_TICK;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const tag = opts.logTag ?? '[file-sweep]';
  const { files, prefixes, mode } = opts;
  const idle = (state: FileSweepState | null): FileSweepResult => ({
    done: state?.done_at != null, finished_now: false, listings: 0, deleted: 0, state,
  });

  if (typeof files?.list !== 'function') return idle(null);
  if (mode === 'delete' && typeof files.delete !== 'function') return idle(null);

  let state: FileSweepState;
  try {
    const saved = parseFileSweepState(await opts.state.read(), mode);
    state = saved && (saved.done_at === null || saved.walk_id === opts.walkId)
      ? saved
      : freshState(mode, opts.walkId, now());
  } catch (err) {
    console.warn(`${tag} state read failed; retried next tick: ${errText(err)}`);
    return idle(null);
  }
  if (state.done_at !== null) return idle(state);

  const startedAt = state.started_at;
  let listings = 0;
  let deletedThisTick = 0;
  while (state.prefix_index < prefixes.length && listings < maxListings && hasBudget()) {
    const prefix = prefixes[state.prefix_index]!;
    let page: SweepFileEntry[];
    let next: string | null;
    try {
      const listed = await bounded(
        files.list(prefix, state.cursor ? { cursor: state.cursor } : {}),
        callTimeoutMs,
        `listing ${prefix}`,
      );
      page = Array.isArray(listed?.files) ? listed.files : [];
      next = listed?.truncated === true && typeof listed.cursor === 'string' && listed.cursor ? listed.cursor : null;
    } catch (err) {
      console.warn(`${tag} listing ${prefix} failed; retried next tick: ${errText(err)}`);
      break;
    }
    listings++;
    state.listings++;

    const pageSeen: Record<string, Tally> = {};
    const pageExpired: Record<string, Tally> = {};
    const pageSkipped = emptyTally();
    const pageSamples: string[] = [];
    const pageDeleted: Record<string, Tally> = {};
    let complete = true;
    for (const entry of page) {
      const key = typeof entry?.key === 'string' ? entry.key : '';
      const bytes = typeof entry?.bytes === 'number' && Number.isFinite(entry.bytes) ? entry.bytes : 0;
      const kind = key.startsWith(prefix) ? opts.classify(key, prefix) : null;
      if (kind === null || (opts.accept && !opts.accept(entry))) {
        pageSkipped.objects += 1;
        pageSkipped.bytes += bytes;
        continue;
      }
      addTally(pageSeen, kind, bytes);
      const uploadedAt = typeof entry.uploaded === 'string' ? Date.parse(entry.uploaded) : NaN;
      if (!Number.isFinite(uploadedAt) || !opts.isExpired(uploadedAt, startedAt, kind)) continue;
      addTally(pageExpired, kind, bytes);
      if (state.samples.length + pageSamples.length < sampleSize) pageSamples.push(key);
      if (mode === 'report') continue;
      // ── delete mode only ──
      if (deletedThisTick >= maxDeletes || !hasBudget()) {
        complete = false;
        break;
      }
      try {
        await bounded(files.delete!(key, opts.deleteOptions?.(entry)), callTimeoutMs, 'delete');
      } catch (err) {
        console.warn(`${tag} delete failed; stopping until the next tick: ${errText(err)}`);
        complete = false;
        break;
      }
      addTally(state.deleted, kind, bytes);
      addTally(pageDeleted, kind, bytes);
      deletedThisTick++;
    }

    if (!complete) {
      // The page is listed again next tick, but the entries deleted from it are gone by then.
      mergeInto(state.seen, pageDeleted);
      mergeInto(state.expired, pageDeleted);
      break;
    }
    mergeInto(state.seen, pageSeen);
    mergeInto(state.expired, pageExpired);
    state.skipped.objects += pageSkipped.objects;
    state.skipped.bytes += pageSkipped.bytes;
    state.samples.push(...pageSamples);
    if (next) {
      state.cursor = next;
    } else {
      state.prefix_index += 1;
      state.cursor = null;
    }
  }

  const finishedNow = state.prefix_index >= prefixes.length;
  if (finishedNow) state.done_at = now();
  if (listings > 0 || finishedNow) {
    try {
      await opts.state.write(JSON.stringify(state));
    } catch (err) {
      console.warn(`${tag} state write failed: ${errText(err)}`);
    }
  }
  return { done: finishedNow, finished_now: finishedNow, listings, deleted: deletedThisTick, state };
}

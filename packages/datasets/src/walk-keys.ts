/**
 * Tombstones for the keys a completed re-walk no longer returns.
 *
 * A keyed dataset upserts by key. When a source restates a day it has
 * already reported (an analytics property finalising a day, a report
 * service recomputing yesterday) and a row moves to another key or
 * disappears, the re-import writes the new rows but nothing removes the old
 * key: the current view keeps both, and anything summing over it double
 * counts. The fix is to append `_deleted: true` for every key the last
 * completed walk of that date wrote and this one did not return.
 *
 * To know those keys, the app keeps, per walk scope (one source, one report
 * family) and date it can still revisit, the key set of the last COMPLETED
 * walk (`done`, one file in the app's own file store). While a walk is in
 * progress each page's keys go to their own file, chained by the page's
 * successor, so a walk that spans many steps (and runs) is still read back
 * whole. When the walk completes, `completeWalk` reads the chain from
 * FIRST_PAGE and returns the keys of `done` it no longer holds; the app
 * appends their tombstones, then `finishWalk` makes the chain the new `done`.
 *
 * Never delete on doubt. Nothing is named for deletion when:
 *   - the chain is broken (a page missing: a partial walk, or a page whose
 *     key write failed after its rows were stored);
 *   - any page hit the source's row cap (the walk did not see the whole day);
 *   - the walk would delete more than MAX_TOMBSTONE_FRACTION of `done`, or
 *     returned nothing at all (a collapsed answer or a key change is not a
 *     restatement).
 * The previous `done` is kept then, so the next normal answer still diffs
 * against it.
 *
 * The app must:
 *   - call `recordWalkPage` after a page's rows are stored and before its
 *     cursor moves past the page, and fail the page when it throws (so every
 *     chain position is rewritten by the walk that completes);
 *   - append the tombstones with a call that THROWS on a refusal, before
 *     `finishWalk`, so a refused append keeps `done` and is retried;
 *   - only track dates it can still revisit (on or after its trailing
 *     window's start), and pass that window start to `finishWalk`.
 *
 * Storage is bounded: `finishWalk` deletes the walk's page files and every
 * set of the scope dated before the window. Keys are stored as their
 * suffix after the walk's `keyPrefix`, gzipped JSON, so a quarter-million-
 * key day of hashed keys is a few MB.
 */

/** The file store the walk needs: an app's own file storage, or a fake. */
export interface WalkKeyStore {
  /** The object's bytes, or null when absent. */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix. */
  list(prefix: string): Promise<string[]>;
}

/**
 * The app-sdk file helpers the adapter below needs (`getAppFile`,
 * `putAppFile`, `deleteAppFile`, `listAppFiles` from @sprigr/apps-app-sdk),
 * passed in so this package keeps no runtime dependency.
 */
export interface AppFilesFns<E> {
  getAppFile(env: E, key: string): Promise<{ base64: string }>;
  putAppFile(env: E, args: { key: string; base64: string; contentType?: string }): Promise<unknown>;
  deleteAppFile(env: E, key: string): Promise<unknown>;
  listAppFiles(env: E, prefix?: string): Promise<{ files: Array<{ key: string }>; truncated?: boolean }>;
}

/**
 * A WalkKeyStore over the app's own R2 files, or null when the install token
 * or platform base is not bound (next dev, an inline route without the bus):
 * the app then keeps no key sets and writes no tombstones. A 404 reads as
 * absent; any other failure rethrows, so the page that needed it fails.
 */
export function appFilesWalkKeyStore<E extends { SPRIGR_INSTALL_TOKEN?: string; SPRIGR_PLATFORM_BASE?: string }>(env: E, fns: AppFilesFns<E>): WalkKeyStore | null {
  if (!env.SPRIGR_INSTALL_TOKEN || !env.SPRIGR_PLATFORM_BASE) return null;
  return {
    async get(key) {
      try {
        return fromBase64((await fns.getAppFile(env, key)).base64);
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },
    async put(key, bytes) {
      await fns.putAppFile(env, { key, base64: toBase64(bytes), contentType: 'application/gzip' });
    },
    async delete(key) {
      await fns.deleteAppFile(env, key);
    },
    async list(prefix) {
      const listed = await fns.listAppFiles(env, prefix);
      // The platform lists at most 1,000 files per call and this list takes no
      // cursor. A short list fails safe (a chain longer than it reads as
      // broken; cleanup converges over later walks), but say so.
      if ((listed as { truncated?: boolean }).truncated) console.warn(`[walk-keys] listing ${prefix} was truncated at ${listed.files.length} file(s); a longer walk reads as a broken chain`);
      return listed.files.map((f) => f.key);
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One walk: a scope directory, the date it covers, and the prefix every row
 *  key of that date and scope starts with. Keys outside the prefix are never
 *  recorded and never named for deletion. */
export interface WalkScope {
  /** File-store directory for this source and report family, no trailing slash. */
  dir: string;
  /** YYYY-MM-DD. */
  date: string;
  keyPrefix: string;
}

/** The position of a walk's first page. Every other position is whatever the
 *  source's cursor is (a page token, `request-offset`); it is hashed into a
 *  file name, so any string works. */
export const FIRST_PAGE = 'first-page';

/** Refuse a walk that would delete more than this share of the last set. */
export const MAX_TOMBSTONE_FRACTION = 0.5;

export interface WalkPage {
  /** The position of the page after this one, or null when this page
   *  completed the day. */
  next: string | null;
  /** This page stopped at the source's row cap with rows left. */
  truncated: boolean;
  /** The row keys this page stored. */
  keys: readonly string[];
}

export type WalkCompletion =
  /** Keys the previous completed walk had and this one did not return. */
  | { kind: 'tombstone'; rowKeys: string[]; previous: number; current: number; suffixes: string[] }
  /** No previous set (or a damaged one): this walk only becomes the baseline. */
  | { kind: 'first'; current: number; suffixes: string[] }
  /** Deletes nothing and keeps the previous set. */
  | { kind: 'skipped'; reason: 'broken_chain' | 'truncated' | 'mass_drop'; previous?: number; current?: number; wouldDelete?: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayDir(s: WalkScope): string {
  return `${s.dir}/${s.date}/`;
}

function doneKey(s: WalkScope): string {
  return `${dayDir(s)}done.json.gz`;
}

async function pageKey(s: WalkScope, position: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(position));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${dayDir(s)}page-${hex.slice(0, 32)}.json.gz`;
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson(bytes: Uint8Array): Promise<unknown | null> {
  try {
    // A copy, so the part is ArrayBuffer-backed (a store may hand back a view of a shared buffer).
    const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  } catch {
    return null;
  }
}

function suffixesOf(s: WalkScope, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) if (k.startsWith(s.keyPrefix) && k.length > s.keyPrefix.length) out.push(k.slice(s.keyPrefix.length));
  return out;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Save one page of an in-progress walk. Call it after the page's rows are
 *  stored and before the cursor moves past it, and fail the page if it throws. */
export async function recordWalkPage(store: WalkKeyStore, scope: WalkScope, position: string, page: WalkPage): Promise<void> {
  await store.put(await pageKey(scope, position), await gzipJson({ v: 1, next: page.next, truncated: page.truncated, keys: suffixesOf(scope, page.keys) }));
}

/** Read the chain from FIRST_PAGE. Null when a page is missing or damaged, or
 *  the chain is longer than the page files that exist (a cycle). */
async function readChain(store: WalkKeyStore, scope: WalkScope): Promise<Array<{ truncated: boolean; keys: string[] }> | null> {
  const maxPages = (await store.list(`${dayDir(scope)}page-`)).length;
  const pages: Array<{ truncated: boolean; keys: string[] }> = [];
  let at: string | null = FIRST_PAGE;
  while (at !== null) {
    if (pages.length >= maxPages) return null;
    const bytes = await store.get(await pageKey(scope, at));
    const page = bytes ? ((await gunzipJson(bytes)) as { next?: unknown; truncated?: unknown; keys?: unknown } | null) : null;
    if (!page || !isStringArray(page.keys) || (page.next !== null && typeof page.next !== 'string')) return null;
    pages.push({ truncated: page.truncated === true, keys: page.keys });
    at = page.next as string | null;
  }
  return pages;
}

/**
 * Decide what the completed walk of `scope` deletes. It only reads: append
 * the tombstones for `rowKeys` with a call that throws on a refusal, then
 * call `finishWalk`. A failed append then re-runs the whole completion.
 */
export async function completeWalk(store: WalkKeyStore, scope: WalkScope): Promise<WalkCompletion> {
  const chain = await readChain(store, scope);
  if (!chain) return { kind: 'skipped', reason: 'broken_chain' };
  const current = new Set(chain.flatMap((p) => p.keys));
  if (chain.some((p) => p.truncated)) return { kind: 'skipped', reason: 'truncated', current: current.size };

  const doneBytes = await store.get(doneKey(scope));
  const stored = doneBytes ? ((await gunzipJson(doneBytes)) as { keys?: unknown } | null) : null;
  const previous = stored && isStringArray(stored.keys) ? stored.keys : null;
  if (!previous) return { kind: 'first', current: current.size, suffixes: [...current] };

  const gone = previous.filter((k) => !current.has(k));
  if (gone.length > 0 && (current.size === 0 || gone.length > previous.length * MAX_TOMBSTONE_FRACTION)) {
    return { kind: 'skipped', reason: 'mass_drop', previous: previous.length, current: current.size, wouldDelete: gone.length };
  }
  return { kind: 'tombstone', rowKeys: gone.map((k) => scope.keyPrefix + k), previous: previous.length, current: current.size, suffixes: [...current] };
}

/**
 * After the tombstones (if any) are stored: move `done` forward when the date
 * can still be revisited, delete the walk's page files, and delete every set
 * of the scope dated before `windowStart`. A skipped completion keeps the
 * previous `done`: a set the walk refused, or saw only part of, never becomes
 * the baseline.
 */
export async function finishWalk(store: WalkKeyStore, scope: WalkScope, completion: WalkCompletion, windowStart: string): Promise<void> {
  if (completion.kind !== 'skipped' && scope.date >= windowStart) {
    await store.put(doneKey(scope), await gzipJson({ v: 1, keys: completion.suffixes }));
  }
  for (const key of await store.list(`${dayDir(scope)}page-`)) await store.delete(key);
  const dir = `${scope.dir}/`;
  for (const key of await store.list(dir)) {
    const date = key.slice(dir.length, dir.length + 10);
    if (DATE_RE.test(date) && date < windowStart) await store.delete(key);
  }
}

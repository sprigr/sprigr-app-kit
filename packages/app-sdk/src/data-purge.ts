/**
 * Removing mirrored rows from an app's data index, from either execution
 * context (sprigr/sprigr-app-kit#123).
 *
 * An app that mirrors an account into its search index must drop that
 * account's rows when the install switches to another account or
 * disconnects; otherwise the next user searches the previous account's data
 * (sprigr/sprigr-apps#2900). Five apps each wrote the same pieces: a data
 * client that uses `env.SPRIGR.data` on a dispatched handler and the
 * install-token routes on an inline route, a prefix listing, and a chunked
 * delete that reports rather than throws. This module is the one copy.
 *
 * The pattern it serves, "snapshot, then purge exactly that":
 *
 *   const before = await snapshotIndexIds(env, [{ prefix: 'trello:card:', index: 'cards' }]);
 *   await storeNewAccountTokens(...);            // the switch
 *   const res = await deleteSnapshotIds(env, before);
 *
 * Rows written after the snapshot (the new account's first sync, a late
 * webhook) are not in it and survive. `purgeIndexByPrefix` is the one-step
 * form for a disconnect, where nothing new is being written.
 *
 * Neither purge function throws. A purge runs inside a connect or disconnect
 * flow that must finish; the result carries `error` and `truncated` so the
 * caller can audit an incomplete purge instead of losing it in a catch.
 *
 * Wire contract (workers/provisioning/src/wfp-data.ts in sprigr-team):
 *   POST /internal/wfp/data/list-ids { prefix, index?, withAcl? }
 *     200 { objectIDs, total, truncated }   (prefix must be non-empty; cap 50000)
 *   POST /internal/wfp/data/delete   { objectIDs, index?, withAcl? }
 *     200 { ok, deleted, index }             (max 1000 ids; unknown ids are no-ops)
 */

import { installTokenPost, resolveInstallBridge, type WfpBridgeEnv } from './wfp-bridge';
import { partialUpdateData } from './platform-data';
import type {
  SprigrDataImportOpts,
  SprigrDataIndexOpts,
  SprigrDataPartialUpdateOpts,
  SprigrDataPartialUpdateResult,
  SprigrDataSearchOpts,
  SprigrDataSearchResult,
} from './index';

/** Options for the id routes: a logical index, and the app's ACL index. */
export interface DataIdsOpts extends SprigrDataIndexOpts {
  withAcl?: boolean;
}

export interface DataListIdsResult {
  objectIDs: string[];
  total: number;
  /** The platform returned its cap's worth and stopped: more rows exist. */
  truncated: boolean;
}

/** How a data call reaches the platform. `none` means it cannot. */
export type DataTransport = 'binding' | 'http' | 'none';

/** The data surface with every member present, whichever transport carries it. */
export interface DataClient {
  via: Exclude<DataTransport, 'none'>;
  import(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
    opts?: SprigrDataImportOpts,
  ): Promise<{ ok: boolean; indexed: number; index: string }>;
  search(opts?: SprigrDataSearchOpts): Promise<SprigrDataSearchResult>;
  get(objectID: string, opts?: SprigrDataIndexOpts): Promise<{ ok: boolean; object: Record<string, unknown> | null; index: string }>;
  partialUpdate(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
    opts?: SprigrDataPartialUpdateOpts,
  ): Promise<SprigrDataPartialUpdateResult>;
  delete(objectIDs: string[], opts?: DataIdsOpts): Promise<{ ok: boolean; deleted: number; index: string }>;
  listIds(prefix: string, opts?: DataIdsOpts): Promise<DataListIdsResult>;
}

/** Bridge call ceiling: a purge sits inside a connect or disconnect request. */
const BRIDGE_TIMEOUT_MS = 20_000;

/** Max ids one delete call takes (the platform's per-call cap). */
export const DATA_DELETE_MAX_IDS = 1000;

type LooseData = Record<string, ((...args: never[]) => Promise<unknown>) | undefined>;

function injectedData(env: WfpBridgeEnv): LooseData | null {
  const data = (env.SPRIGR as { data?: unknown } | undefined)?.data;
  return data && typeof data === 'object' ? (data as LooseData) : null;
}

function idsOpts(opts?: DataIdsOpts): Record<string, unknown> {
  return {
    ...(opts?.index ? { index: opts.index } : {}),
    ...(opts?.withAcl ? { withAcl: true } : {}),
  };
}

/**
 * The app's data surface on either transport, or null when neither exists.
 *
 * Uses `env.SPRIGR.data` when it carries BOTH `listIds` and `delete` (a
 * dispatched handler on a current wrapper build); otherwise the install-token
 * routes, which an inline Next route can reach and an older wrapper build
 * lacks members for. Every member then exists, so callers never feature-detect.
 */
export function makeDataClient(env: WfpBridgeEnv): DataClient | null {
  const data = injectedData(env);
  if (data && typeof data.listIds === 'function' && typeof data.delete === 'function') {
    const d = data as unknown as {
      import: DataClient['import'];
      search: DataClient['search'];
      get: DataClient['get'];
      delete: (ids: string[], o?: DataIdsOpts) => Promise<{ ok?: boolean; deleted?: number; index?: string }>;
      listIds: (p: string, o?: DataIdsOpts) => Promise<{ objectIDs?: string[]; total?: number; truncated?: boolean }>;
    };
    return {
      via: 'binding',
      import: (objects, opts) => d.import(objects, opts),
      search: (opts) => d.search(opts),
      get: (id, opts) => d.get(id, opts),
      partialUpdate: (objects, opts) => partialUpdateData(env, objects, opts),
      async delete(ids, opts) {
        const r = await d.delete(ids, opts);
        return { ok: r?.ok !== false, deleted: typeof r?.deleted === 'number' ? r.deleted : ids.length, index: String(r?.index ?? opts?.index ?? '') };
      },
      async listIds(prefix, opts) {
        const r = await d.listIds(prefix, opts);
        const objectIDs = Array.isArray(r?.objectIDs) ? r.objectIDs : [];
        return { objectIDs, total: typeof r?.total === 'number' ? r.total : objectIDs.length, truncated: r?.truncated === true };
      },
    };
  }

  const bridge = resolveInstallBridge(env);
  if (!bridge) return null;
  const post = (path: string, body: unknown, label: string) =>
    installTokenPost(bridge, path, body, { label, timeoutMs: BRIDGE_TIMEOUT_MS });
  return {
    via: 'http',
    async import(objects, opts) {
      const r = await post('/internal/wfp/data/import', { objects, ...(opts ?? {}) }, 'data.import');
      return { ok: r.ok !== false, indexed: typeof r.indexed === 'number' ? r.indexed : objects.length, index: String(r.index ?? opts?.index ?? '') };
    },
    async search(opts) {
      return (await post('/internal/wfp/data/search', { ...(opts ?? {}) }, 'data.search')) as unknown as SprigrDataSearchResult;
    },
    async get(objectID, opts) {
      const r = await post('/internal/wfp/data/get', { objectID, ...(opts?.index ? { index: opts.index } : {}) }, 'data.get');
      return { ok: r.ok !== false, object: (r.object as Record<string, unknown> | null) ?? null, index: String(r.index ?? opts?.index ?? '') };
    },
    partialUpdate: (objects, opts) => partialUpdateData(env, objects, opts),
    async delete(objectIDs, opts) {
      const r = await post('/internal/wfp/data/delete', { objectIDs, ...idsOpts(opts) }, 'data.delete');
      return { ok: r.ok !== false, deleted: typeof r.deleted === 'number' ? r.deleted : objectIDs.length, index: String(r.index ?? opts?.index ?? '') };
    },
    async listIds(prefix, opts) {
      const r = await post('/internal/wfp/data/list-ids', { prefix, ...idsOpts(opts) }, 'data.listIds');
      const objectIDs = Array.isArray(r.objectIDs) ? (r.objectIDs as string[]) : [];
      return { objectIDs, total: typeof r.total === 'number' ? r.total : objectIDs.length, truncated: r.truncated === true };
    },
  };
}

/** One prefix to list, in one index. A bare string is a prefix in the default index. */
export type IdPrefixSpec = string | ({ prefix: string } & DataIdsOpts);

/** The ids an index held at one moment, grouped by the index they live in. */
export interface IdSnapshot {
  groups: Array<{ index?: string; withAcl?: boolean; ids: string[] }>;
  /** Distinct ids across every group. */
  listed: number;
  /** A listing hit the platform's cap: the snapshot misses some rows. */
  truncated: boolean;
  via: DataTransport;
  /** Set when a listing failed; the groups hold whatever was listed before it. */
  error?: string;
}

export interface PurgeResult {
  deleted: number;
  listed: number;
  truncated: boolean;
  via: DataTransport;
  /** Set when the purge stopped early. `deleted` says how far it got. */
  error?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function groupKey(index: string | undefined, withAcl: boolean | undefined): string {
  return `${withAcl ? 'acl' : 'plain'}\u0000${index ?? ''}`;
}

/**
 * Every id matching the prefixes right now. Never throws. With no data path
 * at all the app cannot have written rows, so the snapshot is empty with
 * `via: 'none'` and no error.
 */
export async function snapshotIndexIds(env: WfpBridgeEnv, prefixes: readonly IdPrefixSpec[]): Promise<IdSnapshot> {
  const client = makeDataClient(env);
  const snap: IdSnapshot = { groups: [], listed: 0, truncated: false, via: client?.via ?? 'none' };
  if (!client) return snap;
  const byGroup = new Map<string, { index?: string; withAcl?: boolean; ids: Set<string> }>();
  try {
    for (const spec of prefixes) {
      const s = typeof spec === 'string' ? { prefix: spec } : spec;
      if (!s.prefix) throw new Error('every prefix must be non-empty (an empty one would list the whole index)');
      const key = groupKey(s.index, s.withAcl);
      let group = byGroup.get(key);
      if (!group) {
        group = { ...(s.index ? { index: s.index } : {}), ...(s.withAcl ? { withAcl: true } : {}), ids: new Set() };
        byGroup.set(key, group);
      }
      const r = await client.listIds(s.prefix, { index: s.index, withAcl: s.withAcl });
      // The platform filters by prefix; this guard keeps a listing bug from
      // ever widening a purge past what the caller named.
      r.objectIDs.forEach((id) => {
        if (id.startsWith(s.prefix)) group!.ids.add(id);
      });
      snap.truncated ||= r.truncated;
    }
  } catch (err) {
    snap.error = `list: ${message(err)}`;
  }
  for (const g of byGroup.values()) {
    snap.groups.push({ ...(g.index ? { index: g.index } : {}), ...(g.withAcl ? { withAcl: true } : {}), ids: [...g.ids] });
    snap.listed += g.ids.size;
  }
  return snap;
}

/**
 * Delete exactly the ids in a snapshot, in chunks of `chunk` (default and
 * ceiling 1000). Never throws. A snapshot that carries a listing error is
 * still purged as far as it goes, and the error is passed on.
 */
export async function deleteSnapshotIds(
  env: WfpBridgeEnv,
  snapshot: IdSnapshot,
  opts?: { chunk?: number },
): Promise<PurgeResult> {
  const res: PurgeResult = {
    deleted: 0,
    listed: snapshot.listed,
    truncated: snapshot.truncated,
    via: snapshot.via,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
  if (snapshot.listed === 0) return res;
  const client = makeDataClient(env);
  if (!client) {
    res.via = 'none';
    res.error = [res.error, 'delete: no data path (env.SPRIGR.data and the install token are both absent)'].filter(Boolean).join('; ');
    return res;
  }
  res.via = client.via;
  const chunk = Math.min(Math.max(Math.trunc(opts?.chunk ?? DATA_DELETE_MAX_IDS), 1), DATA_DELETE_MAX_IDS);
  try {
    for (const g of snapshot.groups) {
      for (let i = 0; i < g.ids.length; i += chunk) {
        const ids = g.ids.slice(i, i + chunk);
        const r = await client.delete(ids, { index: g.index, withAcl: g.withAcl });
        if (!r.ok) throw new Error(`the platform refused ${ids.length} id(s)${g.index ? ` in ${g.index}` : ''}`);
        res.deleted += r.deleted;
      }
    }
  } catch (err) {
    res.error = [res.error, `delete: ${message(err)}`].filter(Boolean).join('; ');
  }
  return res;
}

/** List, then delete, everything matching the prefixes. Never throws. */
export async function purgeIndexByPrefix(
  env: WfpBridgeEnv,
  prefixes: readonly IdPrefixSpec[],
  opts?: { chunk?: number },
): Promise<PurgeResult> {
  return deleteSnapshotIds(env, await snapshotIndexIds(env, prefixes), opts);
}

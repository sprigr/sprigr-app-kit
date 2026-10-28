/**
 * Pending purges (sprigr-app-kit#96): the prefixes a disconnect purge could
 * not finish in one call.
 *
 * purgeActor deletes an actor's rows under a deadline and a capped listing,
 * so a large index can leave rows behind. Before 0.2.0 only an app with its
 * own queue (microsoft-365's migration 0023) finished them; elsewhere the
 * rows stayed searchable under the person's principals until they ran the
 * disconnect again. Now each unfinished prefix is recorded in the app's
 * existing pending-extraction table (no migration) under PURGE_PENDING_TOKEN,
 * and drainPendingPurges finishes it on later ticks.
 *
 * A queued purge re-checks, at drain time, the guards purgeActor applied when
 * it queued it: a person who reconnected keeps their rows, and an install-wide
 * prefix is never purged while another actor indexes under it.
 */

import type { Actor } from '@sprigr/apps-app-sdk';
import type { FileIndexingScope, FileIndexingStore, PendingExtractionRow } from './types';

/** The job token of a pending-purge row. Not a platform extraction job. */
export const PURGE_PENDING_TOKEN = 'purge-pending';
/** Row ids are `purge-pending:<prefix>`, which no indexed objectID starts with. */
const PURGE_ROW_PREFIX = 'purge-pending:';
/** Queued prefixes one drain looks at. */
export const MAX_PURGES_PER_DRAIN = 20;

export function isPurgePendingToken(token: unknown): boolean {
  return token === PURGE_PENDING_TOKEN;
}

/** Whether a store can hold and list pending purges (createD1FileIndexingStore can). */
export function storeSupportsPurgeQueue(store: FileIndexingStore): boolean {
  return typeof store.listPendingContentFills === 'function';
}

/** What a pending-purge row stores. */
export interface QueuedPurge {
  prefix: string;
  actor: Actor;
  connectionId?: string;
  /** The adapter's objectIdsActorScoped when queued: false means the prefix
   *  is the whole install's, so the drain re-checks it is still this actor's. */
  actorScoped: boolean;
}

export function purgeRowId(prefix: string): string {
  return `${PURGE_ROW_PREFIX}${prefix}`;
}

/** Queue prefixes for a later drain. Re-queuing a prefix overwrites its row. */
export async function enqueuePurges(
  store: FileIndexingStore,
  scope: FileIndexingScope,
  prefixes: string[],
  actorScoped: boolean,
): Promise<void> {
  for (const prefix of prefixes) {
    const record: QueuedPurge = { prefix, actor: scope.actor, actorScoped };
    if (scope.connectionId !== undefined) record.connectionId = scope.connectionId;
    await store.upsertPendingExtraction({
      objectId: purgeRowId(prefix),
      jobToken: PURGE_PENDING_TOKEN,
      recordJson: JSON.stringify(record),
      format: 'purge',
    });
  }
}

/** The queued purge a row holds, or null for a row that cannot be one. */
export function parseQueuedPurge(row: Pick<PendingExtractionRow, 'object_id' | 'record_json'>): QueuedPurge | null {
  try {
    const r = JSON.parse(row.record_json) as Partial<QueuedPurge>;
    if (typeof r.prefix !== 'string' || r.prefix.length === 0 || row.object_id !== purgeRowId(r.prefix)) return null;
    if (!r.actor || typeof r.actor !== 'object' || typeof r.actorScoped !== 'boolean') return null;
    return { prefix: r.prefix, actor: r.actor, actorScoped: r.actorScoped, ...(typeof r.connectionId === 'string' ? { connectionId: r.connectionId } : {}) };
  } catch {
    return null;
  }
}

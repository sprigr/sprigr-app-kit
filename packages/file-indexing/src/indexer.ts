/**
 * The per-scope indexing pass and its companions: the full-walk reconcile, the
 * disconnect purge and the permission re-stamp.
 *
 * Invariants every path here keeps (they are why this is one package):
 *   - FAIL CLOSED. A file whose permissions cannot be read is skipped, never
 *     stamped `public`; a row whose principals do not validate is never sent.
 *   - IMPORT BEFORE CURSOR. The cursor (or a full walk's continuation) only
 *     moves after the rows it covers are imported, their seen IDs recorded,
 *     their deletions applied and, on an incremental pass, their events
 *     emitted. Any failure on the way keeps the old cursor; the next pass
 *     re-walks, and every write is an idempotent upsert or delete.
 *   - START-GATED BUDGETS. A deadline stops new pages, files and scopes from
 *     starting; nothing in flight is cut, so every cut lands on a resume point.
 */

import { actorKey, partialUpdateData, type Actor } from '@sprigr/apps-app-sdk';
import { recordAclIdentityLink, removeAclIdentityLink } from '@sprigr/apps-acl-identity-link';
import { isFetchBudgetTimeout, type Deadline } from '@sprigr/apps-fetch-budget';
import { enrichObjectsWithContent, type ExtractionBudget } from './content';
import {
  CONTENT_FILL_BUDGET_MS,
  contentFillToken,
  drainContentFills,
  storeSupportsContentFills,
  type ContentFillOutcome,
} from './content-fill';
import { stampedPrincipalsValid } from './doc-acl';
import { ownerPrincipalOf, stampEntries } from './stamp';
import { emitFileEvents, fileEventNames, type FileEvent } from './events';
import { importFileObjects, MAX_OBJECTS_PER_IMPORT } from './import';
import { forgetPendingExtractions, refreshPendingExtractions, syncPendingRecordPrincipals } from './pending';
import { EMIT_BUDGET_MS, budgetBelow, deadlinePassed } from './tick-budget';
import type {
  ChangePage,
  ExtraScopesResult,
  FileIndexingContext,
  FileIndexingEnv,
  FileIndexingRow,
  FileIndexingScope,
  FileIndexingStore,
  FileSourceAdapter,
  IndexedFileObject,
  RemovedFile,
} from './types';

/** Pages per pass of the main walk (both apps' MAX_DELTA_PAGES). */
export const MAX_WALK_PAGES = 8;

/** Back-off before re-asking the platform to link an owner identity after a
 *  durable owner_not_found refusal (sprigr-team#9075). */
export const IDENTITY_LINK_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** How long a cursor may be held for files whose permissions could not be
 *  read (sprigr-apps#2419) before the pass gives up on them and moves on, so a
 *  file that never resolves cannot freeze an account's indexing. 6 h is 24
 *  retries at a 15-minute cadence. Needs the store's held-since column; without
 *  it the hold has no time limit and is reported on every pass. */
export const MAX_UNRESOLVED_HOLD_MS = 6 * 60 * 60 * 1000;

/** Ids per delete call in a purge: small, so the deadline is re-checked often. */
export const PURGE_DELETE_CHUNK = 250;

/** Do not start a purge listing or delete with less than this left. */
export const MIN_PURGE_LEG_MS = 3_000;

const DEFAULT_LABEL = '[file-indexing]';

export interface IndexActorFilesBudget {
  /** Tick deadline. Pages, files and extra scopes are not STARTED past it. */
  deadline?: Deadline;
  now?: () => number;
  /** Main-walk page cap for this pass (default MAX_WALK_PAGES). */
  maxPages?: number;
  /** Walk the adapter's extra scopes (default true). */
  includeExtraScopes?: boolean;
  /** Event-emission slice (default EMIT_BUDGET_MS). */
  emitBudgetMs?: number;
  /** Override MAX_UNRESOLVED_HOLD_MS. */
  maxUnresolvedHoldMs?: number;
  /** The content-fill drain's slice at the end of the pass (default
   *  CONTENT_FILL_BUDGET_MS; 0 turns the drain off for this pass). The pass
   *  deadline bounds it as well, so it never runs a pass past its deadline. */
  contentFillBudgetMs?: number;
  /** Rows the content-fill drain reads this pass (default MAX_CONTENT_FILLS_PER_PASS). */
  maxContentFills?: number;
}

export interface FileIndexingOutcome {
  indexed: number;
  /** Files skipped fail-closed: permissions hidden from this actor, or no valid principal. */
  skipped: number;
  /** Files whose permission read failed this pass (retried; see `held`). */
  unresolved: number;
  pagesWalked: number;
  extraScopesWalked: number;
  extraScopesDeferred?: number;
  /** Stale rows removed by a completed full walk's reconcile. */
  reconciled?: number;
  eventsEmitted?: number;
  /** The deadline stopped the walk early; the cursor resumes from the cut. */
  cut?: boolean;
  /** The cursor was held at a page with unresolved permissions or unemitted events. */
  held?: boolean;
  /** Another invocation held this scope (adapter.runExclusive); nothing ran. */
  busy?: boolean;
  purgePending?: boolean;
  /** Adapter-specific fields from the extra-scope plan's finish(). */
  extra?: Record<string, unknown>;
  /** 0.1.2 (sprigr-apps#2702): files this pass imported without their text
   *  and queued for a content fill (deadline, extraction cap, 429, failure). */
  contentDeferred?: number;
  /** Queued files whose text this pass's content-fill drain imported. */
  contentFilled?: number;
  /** Files of this scope still searchable by name only, waiting for their
   *  text, after this pass. Absent when the store cannot count them. Show it
   *  (describeContentPending) instead of a bare "ok" while it is above 0. */
  contentPending?: number;
  error?: string;
}

function emptyOutcome(): FileIndexingOutcome {
  return { indexed: 0, skipped: 0, unresolved: 0, pagesWalked: 0, extraScopesWalked: 0 };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDeadlineError(adapter: FileSourceAdapter<any, any>, err: unknown): boolean {
  if (adapter.isDeadlineError) return adapter.isDeadlineError(err);
  return isFetchBudgetTimeout(err) && err.phase === 'budget';
}

/** A placeholder row for scopes the store has nothing for (purge of a never-enabled scope). */
function blankRow(): FileIndexingRow {
  return {
    enabled: 0,
    cursor: null,
    connected_email: null,
    full_walk_active: 0,
    walk_list_token: null,
    walk_start_token: null,
    identity_link_refused_at: null,
    unresolved_held_since: null,
    acl_refresh_link: null,
    acl_refresh_completed_at: null,
    last_indexed_at: null,
    last_status: null,
    last_error: null,
    files_indexed: 0,
    files_skipped: 0,
    raw: {},
  };
}

/** Build the context every adapter call receives. */
export function buildContext<TEnv extends FileIndexingEnv>(
  env: TEnv,
  store: FileIndexingStore,
  scope: FileIndexingScope,
  row: FileIndexingRow,
  opts: { deadline?: Deadline; now?: () => number } = {},
): FileIndexingContext<TEnv> {
  return {
    env,
    scope,
    actor: scope.actor,
    key: actorKey(scope.actor) ?? '',
    walkKey: store.walkKey(scope),
    ownerEmail: row.connected_email ?? undefined,
    row,
    ...(opts.deadline ? { deadline: opts.deadline } : {}),
    now: opts.now ?? Date.now,
  };
}

interface PageRecord {
  /** The token this page was fetched with: the resume point if it is held. */
  cursorBefore: string | null;
  from: number;
  to: number;
  removed: RemovedFile[];
}

/**
 * One indexing pass for one scope: walk (full or incremental), stamp, enrich,
 * import, reconcile, emit, and only then move the cursor. Returns an outcome;
 * provider and write failures are recorded on the row and returned in
 * `error`, never thrown (a store read failure at the very start is thrown).
 */
export async function indexActorFiles<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  env: TEnv,
  scope: FileIndexingScope,
  budget: IndexActorFilesBudget = {},
): Promise<FileIndexingOutcome> {
  const walkKey = store.walkKey(scope);
  const run = () => indexScope(adapter, store, env, scope, budget);
  if (!adapter.runExclusive) return run();
  const guarded = await adapter.runExclusive(scope, walkKey, run, {
    env,
    ...(budget.deadline ? { deadline: budget.deadline } : {}),
    now: budget.now ?? Date.now,
    purpose: 'index',
  });
  if (guarded.busy) {
    return { ...emptyOutcome(), busy: true, ...(guarded.purgePending ? { purgePending: true } : {}) };
  }
  return guarded.value;
}

async function indexScope<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  env: TEnv,
  scope: FileIndexingScope,
  budget: IndexActorFilesBudget,
): Promise<FileIndexingOutcome> {
  const label = adapter.logLabel ?? DEFAULT_LABEL;
  const now = budget.now ?? Date.now;
  const deadline = budget.deadline;
  if (!actorKey(scope.actor)) return { ...emptyOutcome(), error: 'no_actor_key' };

  // Re-read the row: a caller's copy can be a whole tick old (sprigr-apps#2304).
  let row = await store.load(scope);
  if (!row) return { ...emptyOutcome(), error: 'no_file_indexing_row' };
  if (row.enabled !== 1) return emptyOutcome();
  const ctx = buildContext(env, store, scope, row, { deadline, now });
  const walkKey = ctx.walkKey;

  // ── owner email backfill (a row enabled without one) ──
  if (!row.connected_email && adapter.resolveOwnerEmail) {
    let email: string | null = null;
    try {
      email = await adapter.resolveOwnerEmail(ctx);
    } catch (err) {
      console.warn(`${label} owner email lookup failed for ${walkKey}; indexing goes on without it:`, errMsg(err));
    }
    if (email) {
      await store.setConnectedEmail(scope, email);
      // Restart the walk so every row already indexed is re-stamped with the owner.
      await store.resetCursor(scope);
      row = { ...row, connected_email: email, cursor: null, walk_list_token: null, walk_start_token: null };
      ctx.row = row;
      ctx.ownerEmail = email;
    }
  }

  // ── owner identity link (decision 0118), with the owner_not_found back-off ──
  const refusedAt = row.identity_link_refused_at ?? null;
  if (!refusedAt || now() - refusedAt >= IDENTITY_LINK_BACKOFF_MS) {
    const link = await recordAclIdentityLink(env, scope.actor, ctx.ownerEmail);
    if (!link.ok && link.reason === 'owner_not_found') {
      await store.setIdentityLinkRefused(scope, now());
    } else if (refusedAt) {
      await store.setIdentityLinkRefused(scope, null);
    }
  }

  // ── which walk this pass runs ──
  // Two encodings of an in-progress full walk, decided by the store's schema:
  //   - walk-resume columns (google-workspace): the listing continuation and
  //     the baseline captured before the walk live in their own columns, and
  //     the cursor stays NULL until the walk completes (sprigr-apps#2290). A
  //     row with a cursor AND full_walk_active=1 but no continuation is a
  //     pre-0012 abandoned walk and restarts from the top.
  //   - cursor-column (microsoft-365, dropbox): the walk's continuation IS the
  //     cursor (a delta nextLink / list_folder cursor), and the final page's
  //     cursor is the baseline. full_walk_active marks the walk.
  const resumeMode = store.hasWalkResumeColumns;
  let startedFullWalk: boolean;
  let resuming = false;
  let legacyAbandoned = false;
  if (resumeMode) {
    const hasCont = typeof row.walk_list_token === 'string' && row.walk_list_token.length > 0;
    resuming = row.full_walk_active === 1 && hasCont;
    legacyAbandoned = row.cursor !== null && row.full_walk_active === 1 && !hasCont;
    startedFullWalk = legacyAbandoned || (row.cursor === null && !resuming);
  } else {
    startedFullWalk = row.cursor === null;
  }
  const walkActive = startedFullWalk || resuming || row.full_walk_active === 1;
  const inFullWalk = resumeMode ? startedFullWalk || resuming : walkActive;
  if (startedFullWalk) {
    if (legacyAbandoned) await store.resetCursor(scope);
    await store.clearWalkSeen(walkKey);
    await store.setFullWalkActive(scope, true);
  }

  const maxPages = budget.maxPages ?? MAX_WALK_PAGES;
  const maxHold = budget.maxUnresolvedHoldMs ?? MAX_UNRESOLVED_HOLD_MS;
  const heldSince = row.unresolved_held_since ?? null;
  const releaseHold = store.hasHeldSinceColumn && heldSince !== null && now() - heldSince >= maxHold;

  const pages: PageRecord[] = [];
  const objects: IndexedFileObject[] = [];
  const mimeByObjectId = new Map<string, string>();
  const seenIds: string[] = [];
  let skipped = 0;
  let unresolved = 0;
  let releasedUnresolved = 0;
  let pagesWalked = 0;
  let cut = false;
  let walkComplete = false;
  let heldPage: number | null = null;
  let nextCursor: string | null = null;
  let walkStartToken: string | null = resumeMode && resuming ? row.walk_start_token : null;
  let pageToken: string | null = inFullWalk ? (resumeMode ? (resuming ? row.walk_list_token : null) : row.cursor) : row.cursor;
  let walkListToken: string | null = null;

  try {
    if (inFullWalk && resumeMode && !walkStartToken && adapter.seedCursor) {
      walkStartToken = await adapter.seedCursor(ctx);
    }
    let listedThisTick = 0;
    for (let p = 0; p < maxPages; p++) {
      if (deadlinePassed(deadline, now)) {
        cut = true;
        break;
      }
      let tokenUsed = pageToken;
      let page: ChangePage<TEntry>;
      try {
        page = inFullWalk ? await adapter.fullWalk(pageToken, ctx) : await adapter.listChanges(pageToken as string, ctx);
        if (page.restartWalk) {
          if (!(resumeMode && resuming && listedThisTick === 0)) {
            throw new Error('walk_continuation_rejected: the source rejected the stored listing continuation');
          }
          console.warn(`${label} stored listing continuation rejected for ${walkKey}; restarting the full walk from the top`);
          await store.clearWalkSeen(walkKey);
          walkStartToken = adapter.seedCursor ? await adapter.seedCursor(ctx) : null;
          pageToken = null;
          tokenUsed = null;
          page = await adapter.fullWalk(null, ctx);
          if (page.restartWalk) throw new Error('walk_continuation_rejected: the source rejected a fresh listing');
        }
      } catch (err) {
        if (isDeadlineError(adapter, err)) {
          // A page in flight hit the tick deadline: same as the between-pages
          // check catching it one page earlier. Not a row error.
          cut = true;
          break;
        }
        throw err;
      }
      if (page.reset) {
        await store.resetCursor(scope);
        const detail = adapter.cursorResetDetail ?? 'cursor_expired_reset';
        await store.recordError(scope, detail);
        return { ...emptyOutcome(), pagesWalked, error: detail };
      }
      pagesWalked++;
      listedThisTick++;

      const rec: PageRecord = { cursorBefore: tokenUsed, from: objects.length, to: objects.length, removed: page.removed ?? [] };
      if (walkActive) for (const e of page.entries) seenIds.push(adapter.objectIdOf(e, ctx));
      const stamped = await stampEntries(adapter, ctx, page.entries);
      objects.push(...stamped.objects);
      for (const [id, mime] of stamped.mimes) mimeByObjectId.set(id, mime);
      skipped += stamped.skipped;
      rec.to = objects.length;
      pages.push(rec);

      if (stamped.unresolved > 0) {
        unresolved += stamped.unresolved;
        if (!releaseHold) {
          // sprigr-apps#2419: these files exist but their permissions could not
          // be read. Moving the cursor past them would leave them unindexed
          // until they next change, so stop here and resume from this page.
          heldPage = pages.length - 1;
          break;
        }
        releasedUnresolved += stamped.unresolved;
        skipped += stamped.unresolved;
      }

      if (inFullWalk && resumeMode) {
        if (!page.hasMore) {
          walkComplete = true;
          nextCursor = walkStartToken ?? page.cursor;
          break;
        }
        pageToken = page.cursor;
        if (!pageToken) break;
        continue;
      }
      if (!page.hasMore && page.cursor) {
        nextCursor = page.cursor;
        walkComplete = true;
        break;
      }
      if (page.hasMore && page.cursor) {
        pageToken = page.cursor;
        nextCursor = page.cursor;
        continue;
      }
      break;
    }
  } catch (err) {
    const detail = errMsg(err);
    await store.recordError(scope, detail);
    return { ...emptyOutcome(), pagesWalked, error: detail };
  }

  if (heldPage !== null) {
    const resumeAt = pages[heldPage]!.cursorBefore;
    if (inFullWalk && resumeMode) walkListToken = resumeAt;
    else nextCursor = resumeAt;
  } else if (inFullWalk && resumeMode && !walkComplete) {
    walkListToken = pageToken;
  }

  // ── content (best-effort, bounded) ──
  const extractBudget: ExtractionBudget = { extracted: 0, deferred: 0 };
  const throttled = new Set<string>();
  const enriched = await enrichObjectsWithContent(adapter, store, ctx, objects, { mimeByObjectId, budget: extractBudget, throttled });
  let contentDeferred = enriched.recorded;
  let fillRecordFailed = enriched.recordFailed;

  // ── extra scopes (re-listed whole each pass; no cursor, no events) ──
  let extraScopesWalked = 0;
  let extraScopesDeferred = 0;
  let extraError: string | undefined;
  const extra: Record<string, unknown> = {};
  if (budget.includeExtraScopes !== false && adapter.extraScopes) {
    let plan: Awaited<ReturnType<NonNullable<typeof adapter.extraScopes>>> = null;
    try {
      plan = await adapter.extraScopes(ctx);
    } catch (err) {
      console.warn(`${label} extra-scope planning failed for ${walkKey}; skipping them this pass:`, errMsg(err));
    }
    if (plan) {
      const result: ExtraScopesResult = { walked: [], deferredFrom: null, deferred: 0, errors: [] };
      for (const [i, sc] of plan.scopes.entries()) {
        if (deadlinePassed(deadline, now)) {
          result.deferred = plan.scopes.length - i;
          result.deferredFrom = sc.id;
          break;
        }
        try {
          const entries = await sc.list(ctx);
          const stamped = await stampEntries(adapter, ctx, entries);
          // A re-listed scope has no cursor to hold: an unresolved file is
          // skipped this pass and read again on the next one.
          skipped += stamped.skipped + stamped.unresolved;
          for (const [id, mime] of stamped.mimes) mimeByObjectId.set(id, mime);
          const scopeEnriched = await enrichObjectsWithContent(adapter, store, ctx, stamped.objects, {
            mimeByObjectId,
            budget: extractBudget,
            throttled,
          });
          contentDeferred += scopeEnriched.recorded;
          fillRecordFailed ??= scopeEnriched.recordFailed;
          objects.push(...stamped.objects);
          result.walked.push(sc.id);
        } catch (err) {
          if (isDeadlineError(adapter, err)) {
            result.deferred = plan.scopes.length - i;
            result.deferredFrom = sc.id;
            break;
          }
          console.warn(`${label} extra scope ${sc.id} failed for ${walkKey}; skipping it:`, errMsg(err));
          result.errors.push(errMsg(err));
        }
      }
      extraScopesWalked = result.walked.length;
      extraScopesDeferred = result.deferred;
      if (result.errors.length > 0) extraError = `${plan.errorCode ?? 'extra_scope_failed'}: ${result.errors[0]}`;
      if (plan.finish) {
        try {
          const fields = await plan.finish(result);
          if (fields) Object.assign(extra, fields);
        } catch (err) {
          console.warn(`${label} extra-scope finish failed for ${walkKey}:`, errMsg(err));
        }
      }
    }
  }
  const base = (): FileIndexingOutcome => ({
    ...emptyOutcome(),
    skipped,
    unresolved,
    pagesWalked,
    extraScopesWalked,
    ...(extraScopesDeferred > 0 ? { extraScopesDeferred } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });

  // ── a content gap nothing would come back for keeps the cursor (sprigr-apps#2702) ──
  if (fillRecordFailed !== undefined) {
    const detail = `content_fill_record_failed: ${fillRecordFailed}`;
    await store.recordError(scope, detail);
    return { ...base(), error: detail };
  }

  // ── import BEFORE the cursor ──
  let indexed = 0;
  if (objects.length > 0) {
    try {
      // The drain must attach its text to THIS metadata (sprigr-apps#2291).
      await refreshPendingExtractions(store, objects);
    } catch (err) {
      const detail = `pending_extraction_refresh_failed: ${errMsg(err)}`;
      await store.recordError(scope, detail);
      return { ...base(), error: detail };
    }
    try {
      indexed = await importFileObjects(env, objects, { label });
    } catch (err) {
      const detail = `import_failed: ${errMsg(err)}`;
      await store.recordError(scope, detail);
      return { ...base(), error: detail };
    }
  }

  // ── seen set, after the import (a seen ID never outruns its row) ──
  if (walkActive && seenIds.length > 0) {
    try {
      await store.recordWalkSeen(walkKey, seenIds);
    } catch (err) {
      const detail = `walk_seen_record_failed: ${errMsg(err)}`;
      await store.recordError(scope, detail);
      return { ...base(), indexed, error: detail };
    }
  }

  // ── deletions: a removal is reported once, so a failed delete keeps the cursor ──
  const removed = pages.flatMap((p) => p.removed);
  const data = env.SPRIGR?.data;
  if (removed.length > 0 && data?.delete) {
    const ids = removed.map((r) => r.objectID);
    try {
      for (let i = 0; i < ids.length; i += MAX_OBJECTS_PER_IMPORT) {
        await data.delete(ids.slice(i, i + MAX_OBJECTS_PER_IMPORT), { withAcl: true });
      }
      await forgetPendingExtractions(store, ids);
    } catch (err) {
      const detail = `delete_failed: ${errMsg(err)}`;
      await store.recordError(scope, detail);
      return { ...base(), indexed, error: detail };
    }
  }

  // ── full-walk reconcile, still before the cursor ──
  let reconciled: number | undefined;
  if (walkComplete && inFullWalk) {
    // Only for the walk this pass belongs to (sprigr-apps#2304): if another
    // invocation completed or restarted it meanwhile, its reconcile already
    // ran against the whole seen set and ours would run against an empty one.
    const current = await store.load(scope).catch(() => null);
    const startPos = resumeMode ? row.walk_list_token : row.cursor;
    const curPos = current ? (resumeMode ? current.walk_list_token : current.cursor) : undefined;
    const stillOurs = current !== null && current.full_walk_active === 1 && curPos === startPos;
    if (!stillOurs) {
      console.warn(`${label} reconcile skipped for ${walkKey}: the walk state moved under this run; nothing deleted`);
    } else {
      try {
        // sprigr-apps#2690: the walk reached its final page with no error,
        // cut or hold (walkComplete) AND established a cursor, so an empty
        // seen set proves the source is empty and every row is stale.
        reconciled = await reconcileWalk(adapter, store, ctx, { completedWalk: nextCursor !== null });
      } catch (err) {
        const detail = `reconcile_failed: ${errMsg(err)}`;
        await store.recordError(scope, detail);
        return { ...base(), indexed, error: detail };
      }
    }
  }

  // ── events: incremental passes only (a full walk is history, not news) ──
  let eventsEmitted: number | undefined;
  let eventsHeld = false;
  if (!walkActive) {
    const names = fileEventNames(adapter.eventPrefix);
    const events: FileEvent[] = [];
    for (const [pi, rec] of pages.entries()) {
      if (heldPage !== null && pi >= heldPage) break;
      for (const o of objects.slice(rec.from, rec.to)) {
        if (o.isFolder === 'true') continue;
        if (adapter.emitsEventsFor && !adapter.emitsEventsFor(o)) continue;
        const idField = adapter.eventIdField;
        events.push({
          name: o.createdAt && o.createdAt === o.modifiedAt ? names.created : names.updated,
          page: pi,
          payload: {
            name: o.name ?? '',
            path: o.path ?? '',
            webUrl: o.webUrl ?? '',
            mimeType: o.mimeType ?? '',
            size: o.size ?? 0,
            ...(idField ? { [idField]: o[idField] ?? '' } : {}),
            driveId: o.driveId ?? '',
            source: o.source ?? '',
            modifiedAt: o.modifiedAt ?? '',
            modifiedBy: o.modifiedBy ?? '',
            objectID: o.objectID,
          },
        });
      }
      for (const r of rec.removed) {
        events.push({
          name: names.deleted,
          page: pi,
          payload: { ...r },
          ...(adapter.claimDeletedEvent ? { claimObjectID: r.objectID } : {}),
        });
      }
    }
    const emitted = await emitFileEvents(env, events, {
      deadline: { at: now() + (budget.emitBudgetMs ?? EMIT_BUDGET_MS) },
      now,
      label,
      ...(adapter.claimDeletedEvent ? { claim: (id: string) => adapter.claimDeletedEvent!(id, ctx) } : {}),
      ...(adapter.releaseDeletedEvent ? { release: (id: string) => adapter.releaseDeletedEvent!(id, ctx) } : {}),
    });
    eventsEmitted = emitted.emitted;
    if (emitted.firstUnattemptedPage !== null) {
      // sprigr-apps#2521: resume at the first page we could not announce.
      nextCursor = pages[emitted.firstUnattemptedPage]!.cursorBefore;
      eventsHeld = true;
    }
  }

  // ── move the cursor ──
  const held = heldPage !== null || eventsHeld;
  if (resumeMode && inFullWalk && !walkComplete) {
    await store.recordWalkProgress(scope, {
      listToken: walkListToken,
      startToken: walkListToken ? walkStartToken : null,
      indexed,
      skipped,
    });
  } else {
    await store.recordSuccess(scope, nextCursor ?? row.cursor, indexed, skipped);
  }
  if (store.hasHeldSinceColumn) {
    if (heldPage !== null && heldSince === null) await store.setUnresolvedHeldSince(scope, now());
    else if (heldPage === null && heldSince !== null) await store.setUnresolvedHeldSince(scope, null);
  }

  const problems: string[] = [];
  if (extraError) problems.push(extraError);
  if (heldPage !== null) {
    problems.push(
      `permissions_unresolved: ${unresolved} file(s) could not have their permissions read; the cursor holds so they are retried next run`,
    );
  } else if (releasedUnresolved > 0) {
    problems.push(
      `permissions_unresolved_released: ${releasedUnresolved} file(s) skipped after the cursor was held for ${Math.round(maxHold / 60_000)} min`,
    );
  }
  const error = problems.length > 0 ? problems.join('; ') : undefined;
  if (error) await store.recordError(scope, error);

  // ── content fills: after the cursor, inside what is left of the deadline ──
  const fill = await runContentFills(adapter, store, ctx, budget, { budget: extractBudget, throttled, label });

  return {
    ...base(),
    indexed,
    ...(contentDeferred > 0 ? { contentDeferred } : {}),
    ...(fill.filled > 0 ? { contentFilled: fill.filled } : {}),
    ...(fill.pending !== undefined ? { contentPending: fill.pending } : {}),
    ...(reconciled !== undefined ? { reconciled } : {}),
    ...(eventsEmitted !== undefined ? { eventsEmitted } : {}),
    ...(cut ? { cut: true } : {}),
    ...(held ? { held: true } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The end-of-pass content-fill step: count this scope's waiting rows, drain a
 * bounded batch if there are any, and report what is left. Never throws: a
 * store failure here only leaves the count unknown.
 */
async function runContentFills<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  ctx: FileIndexingContext<TEnv>,
  budget: IndexActorFilesBudget,
  shared: { budget: ExtractionBudget; throttled: Set<string>; label: string },
): Promise<{ filled: number; pending?: number }> {
  if (!storeSupportsContentFills(store) || !ctx.walkKey || !store.countPendingContentFills) return { filled: 0 };
  const token = contentFillToken(ctx.walkKey);
  let pending: number;
  try {
    pending = await store.countPendingContentFills(token);
  } catch (err) {
    console.warn(`${shared.label} content-fill count failed for ${ctx.walkKey}:`, errMsg(err));
    return { filled: 0 };
  }
  const sliceMs = budget.contentFillBudgetMs ?? CONTENT_FILL_BUDGET_MS;
  if (pending === 0 || sliceMs <= 0) return { filled: 0, pending };
  const out: ContentFillOutcome = await drainContentFills(adapter, store, ctx, {
    ...(ctx.deadline ? { deadline: ctx.deadline } : {}),
    budgetMs: sliceMs,
    ...(budget.maxContentFills !== undefined ? { maxFills: budget.maxContentFills } : {}),
    budget: shared.budget,
    throttled: shared.throttled,
    label: shared.label,
  });
  return { filled: out.filled, pending: Math.max(0, pending - out.filled - out.converted - out.dropped) };
}

/**
 * Remove index rows whose source files no longer exist, at the completion of
 * a FULL walk: list the index under each reconcile prefix and delete what the
 * walk's seen set lacks. Diff-of-listing only, so a truncated listing heals
 * less, never deletes wrongly. With install-scoped objectIDs it deletes only
 * when no other actor indexes the install (another actor's rows would look
 * unseen). Feature-detected: without listIds + delete it skips with a warning.
 * Always clears the seen set and the walk marker. THROWS on a listing or
 * delete failure so the caller keeps the cursor. Emits no events.
 *
 * An EMPTY seen set (sprigr-apps#2690: the user emptied the drive) deletes
 * every row under the prefixes, but only with `opts.completedWalk`, which
 * the caller sets when the walk provably finished (final page, no error, no
 * cut, no hold, cursor established). The prefixes are then
 * `reconcilePrefixes([], ctx)` when the adapter has it (so an adapter that
 * keeps some rows out of the diff, such as microsoft-365's SharePoint rows,
 * still decides), else `objectIdPrefix(ctx)`. A truncated listing in that
 * case deletes the listed subset (every listed row is stale) and logs that
 * more remain for the next completed walk. A
 * direct caller that omits `opts` keeps the 0.1.0 behaviour: an empty seen
 * set deletes nothing.
 */
export async function reconcileWalk<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  ctx: FileIndexingContext<TEnv>,
  opts: { completedWalk?: boolean } = {},
): Promise<number> {
  const label = adapter.logLabel ?? DEFAULT_LABEL;
  const data = ctx.env.SPRIGR?.data;
  let removed = 0;
  if (data?.listIds && data.delete) {
    const seen = await store.listWalkSeen(ctx.walkKey);
    const seenSet = new Set(seen);
    const emptyWalk = seenSet.size === 0;
    let prefixes: string[] = [];
    if (!emptyWalk || opts.completedWalk === true) {
      prefixes = adapter.reconcilePrefixes ? adapter.reconcilePrefixes(seen, ctx) : [adapter.objectIdPrefix(ctx)];
      if (!adapter.objectIdsActorScoped && prefixes.length > 0) {
        const others = await store.countOtherActors(ctx.scope);
        if (others > 0) {
          console.warn(
            `${label} reconcile skipped for ${ctx.walkKey}: ${others} other actor(s) index this install and objectIDs are not actor-scoped, so unseen rows may belong to another actor`,
          );
          prefixes = [];
        }
      }
    }
    for (const prefix of prefixes) {
      const listing = await data.listIds(prefix, { withAcl: true });
      if (listing.truncated && emptyWalk) {
        // The walk proved the source empty, so every listed row is stale:
        // delete what the listing shows; the next completed walk continues.
        console.warn(
          `${label} reconcile of an empty walk: listing truncated for ${prefix}; deleting the listed subset, more rows remain for the next completed walk`,
        );
      } else if (listing.truncated) {
        console.warn(`${label} reconcile listing truncated for ${prefix}; healing the listed subset only`);
      }
      const stale = listing.objectIDs.filter((id) => id.startsWith(prefix) && !seenSet.has(id));
      for (let i = 0; i < stale.length; i += MAX_OBJECTS_PER_IMPORT) {
        await data.delete(stale.slice(i, i + MAX_OBJECTS_PER_IMPORT), { withAcl: true });
      }
      await forgetPendingExtractions(store, stale);
      removed += stale.length;
    }
    const plainPrefix = adapter.plainIndexSweepPrefix?.(ctx);
    if (plainPrefix) {
      const plain = await data.listIds(plainPrefix, { withAcl: false });
      for (let i = 0; i < plain.objectIDs.length; i += MAX_OBJECTS_PER_IMPORT) {
        await data.delete(plain.objectIDs.slice(i, i + MAX_OBJECTS_PER_IMPORT), { withAcl: false });
      }
      removed += plain.objectIDs.length;
    }
    if (removed > 0) console.log(`${label} reconcile removed ${removed} stale rows for ${ctx.walkKey}`);
  } else {
    console.warn(
      `${label} reconcile skipped for ${ctx.walkKey}: data.listIds/delete unavailable (platform predates the list-ids surface)`,
    );
  }
  await store.clearWalkSeen(ctx.walkKey);
  await store.setFullWalkActive(ctx.scope, false);
  return removed;
}

/** Rows in the ACL index under `prefix`, read from the index itself (the
 *  files_indexed column is a running total of imports, not a count). Null
 *  when the platform has no listIds; throws when the listing fails. */
export async function countIndexedItems(
  env: FileIndexingEnv,
  prefix: string,
): Promise<{ total: number; truncated: boolean } | null> {
  const listIds = env.SPRIGR?.data?.listIds;
  if (!listIds) return null;
  const listing = await listIds(prefix, { withAcl: true });
  let total = 0;
  for (const id of listing.objectIDs) if (id.startsWith(prefix)) total++;
  return { total, truncated: listing.truncated };
}

/** What one purgeIndexPrefix pass did (0.1.1 shape, sprigr-app-kit#99). */
export interface PurgePrefixResult {
  /** Ids a delete was issued for in THIS pass, including the chunks deleted
   *  before a failure. */
  removed: number;
  /** True only when the listing was whole, every listed id was deleted, and
   *  nothing failed. Equals `!truncated && !cut && !error && !unavailable`.
   *  Kept from 0.1.0. */
  complete: boolean;
  /** The listing stopped at the platform's cap: more ids remain beyond it. */
  truncated: boolean;
  /** The deadline left less than MIN_PURGE_LEG_MS before every listed id was
   *  deleted. */
  cut: boolean;
  /** The platform has no listIds/delete surface; nothing was attempted. */
  unavailable?: boolean;
  /** The listing, a delete, or the pending-extraction cleanup failed; the
   *  pass stopped there. `removed` still counts what went before it. */
  error?: string;
}

/**
 * Delete every ACL-index row under `prefix`: one listing, then deletes of
 * PURGE_DELETE_CHUNK ids, dropping matching pending extractions with each
 * chunk, stopping when less than MIN_PURGE_LEG_MS of the deadline is left.
 * When `complete` is false (`truncated`, `cut` or `error` says why), call
 * again on a later pass: an index read straight after a delete can still
 * return deleted ids, so do not re-list in the same pass.
 *
 * Never throws (0.1.1; 0.1.0 threw on a listing or delete failure and lost
 * the partial `removed` count). A failure comes back in `error`, with
 * `complete: false`, so a caller that records failures must read `error`.
 */
export async function purgeIndexPrefix(
  env: FileIndexingEnv,
  store: FileIndexingStore,
  prefix: string,
  opts: { deadline?: Deadline; now?: () => number } = {},
): Promise<PurgePrefixResult> {
  const now = opts.now ?? Date.now;
  const data = env.SPRIGR?.data;
  if (!data?.listIds || !data.delete) return { removed: 0, complete: false, truncated: false, cut: false, unavailable: true };
  let removed = 0;
  let truncated = false;
  let cut = false;
  try {
    const listing = await data.listIds(prefix, { withAcl: true });
    truncated = listing.truncated === true;
    const ids = listing.objectIDs.filter((id) => id.startsWith(prefix));
    for (let i = 0; i < ids.length; i += PURGE_DELETE_CHUNK) {
      if (budgetBelow(MIN_PURGE_LEG_MS, opts.deadline, now)) {
        cut = true;
        break;
      }
      const chunk = ids.slice(i, i + PURGE_DELETE_CHUNK);
      await data.delete(chunk, { withAcl: true });
      removed += chunk.length;
      await forgetPendingExtractions(store, chunk);
    }
  } catch (err) {
    return { removed, complete: false, truncated, cut, error: errMsg(err) };
  }
  return { removed, complete: !cut && !truncated, truncated, cut };
}

export interface PurgeActorResult {
  /** Indexing was switched off (the row stays as the opt-out tombstone). */
  disabled: boolean;
  unlinked: boolean;
  prefixes: string[];
  removed: number;
  /** Every prefix was listed in full and deleted. False = call again later. */
  complete: boolean;
  /** Why rows were not purged: install-scoped objectIDs shared with other
   *  actors (google-workspace with more than one indexing user); install-
   *  scoped ids and this actor has no indexing row (nothing in the index is
   *  provably theirs); no listIds/delete surface; or no actor key. */
  purgeSkipped?: 'shared_prefix' | 'no_indexing_row' | 'unavailable' | 'no_actor_key';
  errors: string[];
}

/**
 * Disconnect cleanup (sprigr-apps#2355), in the order that survives a timeout:
 *   1. switch indexing off FIRST, so nothing re-indexes while the rest runs;
 *   2. drop the owner identity link;
 *   3. delete the scope's rows from the ACL index, bounded by `deadline`;
 *   4. clear the walk state.
 * Never throws; every failure is in `errors`, and an incomplete purge reports
 * `complete: false`. The store keeps NO durable purge-pending state: the
 * caller must queue the rest itself (and drain it with purgeIndexPrefix) or
 * tell the user to disconnect again. Write the audit row from the result. With install-scoped objectIDs and other actors indexing, rows
 * cannot be told apart by id, so the purge is skipped (`shared_prefix`):
 * which actor a shared file "belongs to" is a design decision the package
 * does not guess at.
 */
export async function purgeActor<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  env: TEnv,
  scope: FileIndexingScope,
  opts: { deadline?: Deadline; now?: () => number; email?: string | null } = {},
): Promise<PurgeActorResult> {
  const result: PurgeActorResult = { disabled: false, unlinked: false, prefixes: [], removed: 0, complete: false, errors: [] };
  if (!actorKey(scope.actor)) return { ...result, purgeSkipped: 'no_actor_key' };
  let row: FileIndexingRow | null = null;
  try {
    row = await store.load(scope);
  } catch (err) {
    result.errors.push(`load: ${errMsg(err)}`);
  }
  try {
    result.disabled = await store.disable(scope);
  } catch (err) {
    result.errors.push(`disable: ${errMsg(err)}`);
  }
  // Without a connection the whole actor goes, so every link the owner made
  // on this install is dropped. With one, only that connection's address: an
  // unknown address is left linked rather than unlinking the owner's OTHER
  // connections, which would hide their own files from them.
  const email = opts.email !== undefined ? opts.email : scope.connectionId ? (row?.connected_email ?? null) : null;
  if (scope.connectionId !== undefined && !email) {
    result.errors.push('unlink: no address known for this connection; identity link left in place');
  } else {
    await removeAclIdentityLink(env, scope.actor, email ?? undefined);
    result.unlinked = true;
  }

  const ctx = buildContext(env, store, scope, row ?? blankRow(), opts);
  let prefixes: string[] = [];
  try {
    if (!adapter.objectIdsActorScoped && row === null) {
      // Install-scoped ids (`gw:file:<id>`) name no actor, so the prefix is the
      // WHOLE install's index. With no row this actor never indexed (or its
      // row could not be read): deleting the prefix would wipe rows that are
      // not provably theirs, so nothing is purged.
      result.purgeSkipped = 'no_indexing_row';
    } else {
      prefixes = adapter.purgePrefixes ? await adapter.purgePrefixes(ctx) : [adapter.objectIdPrefix(ctx)];
      if (!adapter.objectIdsActorScoped && (await store.countOtherActors(scope)) > 0) {
        result.purgeSkipped = 'shared_prefix';
        prefixes = [];
      }
    }
  } catch (err) {
    result.errors.push(`prefixes: ${errMsg(err)}`);
    prefixes = [];
  }
  result.prefixes = prefixes;
  let allComplete = true;
  for (const prefix of prefixes) {
    const r = await purgeIndexPrefix(env, store, prefix, opts);
    result.removed += r.removed;
    if (r.unavailable) result.purgeSkipped = 'unavailable';
    if (!r.complete) allComplete = false;
    if (r.error !== undefined) result.errors.push(`purge ${prefix}: ${r.error}`);
  }
  result.complete = allComplete && result.errors.length === 0 && !result.purgeSkipped;
  try {
    await store.clearWalkSeen(ctx.walkKey);
    if (row) await store.setFullWalkActive(scope, false);
  } catch (err) {
    result.errors.push(`walk_state: ${errMsg(err)}`);
  }
  // The scope's content fills go whatever happened to the rows: with indexing
  // off nothing drains them, and a shared prefix keeps the OTHER actors' rows,
  // whose fills carry their own walk keys (sprigr-apps#2702).
  if (ctx.walkKey && store.deletePendingContentFills) {
    try {
      await store.deletePendingContentFills(contentFillToken(ctx.walkKey));
    } catch (err) {
      result.errors.push(`content_fills: ${errMsg(err)}`);
    }
  }
  return result;
}

// ── permission re-stamp (sprigr-apps#2211) ─────────────────────────────

/** Gap between completed re-stamp passes. */
export const ACL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Pages one scope's re-stamp may walk per tick. */
export const ACL_REFRESH_MAX_PAGES_PER_TICK = 4;
/** Start a re-stamp page only with at least this much of the tick left. */
export const ACL_REFRESH_PAGE_HEADROOM_MS = 10_000;

export interface AclRefreshOutcome {
  pages: number;
  /** Rows whose acl_principals changed, as the platform counts them. */
  restamped: number;
  /** Items the index holds no row for (the walk owns creating rows). */
  missing: number;
  /** Items left as stamped: permissions unreadable, or no valid principal. */
  skipped: number;
  completed: boolean;
  busy?: boolean;
  error?: string;
}

/** Whether a re-stamp pass should run now: only after the first walk
 *  completed, never during a full walk (it re-imports every row anyway). */
export function aclRefreshDue(row: FileIndexingRow, nowMs: number, intervalMs: number = ACL_REFRESH_INTERVAL_MS): boolean {
  if (row.cursor === null || row.full_walk_active === 1) return false;
  if (row.acl_refresh_link) return true;
  const last = row.acl_refresh_completed_at ?? null;
  return last === null || nowMs - last >= intervalMs;
}

type RestampFn = (
  env: FileIndexingEnv,
  patches: Array<{ objectID: string; acl_principals: string[] }>,
) => Promise<{ updated: number; skippedMissing: number }>;

/** Default write: app-sdk `partialUpdateData` with `withAcl`, which refuses a
 *  reply that patched anything but the -acl-files index. */
const defaultRestamp: RestampFn = async (env, patches) => {
  const reply = await partialUpdateData(env as Parameters<typeof partialUpdateData>[0], patches, { withAcl: true });
  return { updated: reply.updated, skippedMissing: reply.skippedMissing };
};

/**
 * Opt-in permission re-stamp for sources whose change feed misses sharing-only
 * changes (OneDrive's delta, measured 2026-10-02). Walks the adapter's own
 * enumeration (`aclRefreshPage`, on its own continuation in the store's
 * acl-refresh columns), resolves principals the same way the walk does, and
 * writes `{ objectID, acl_principals }` patches with `data.partialUpdate`
 * `withAcl`: rows that exist get the new list, nothing is created, and the
 * extracted content is left alone (a whole-row re-import would wipe it).
 * Fail closed: an item whose permissions cannot be read keeps its stamp.
 *
 * Returns null when the adapter or store does not support it, or the pass is
 * not due. Never throws for a provider or write failure: the outcome carries
 * `error` and the stored link still points at the first page not re-stamped.
 */
export async function refreshAclPrincipals<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  env: TEnv,
  scope: FileIndexingScope,
  opts: {
    deadline?: Deadline;
    now?: () => number;
    intervalMs?: number;
    maxPages?: number;
    pageHeadroomMs?: number;
    restamp?: RestampFn;
  } = {},
): Promise<AclRefreshOutcome | null> {
  const now = opts.now ?? Date.now;
  if (!adapter.aclRefreshPage || !store.hasAclRefreshColumns || !actorKey(scope.actor)) return null;
  const pass = async (): Promise<AclRefreshOutcome | null> => {
    const row = await store.load(scope).catch(() => null);
    if (!row || row.enabled !== 1 || !aclRefreshDue(row, now(), opts.intervalMs)) return null;
    return runAclRefresh(adapter, store, env, scope, row, opts);
  };
  if (!adapter.runExclusive) return pass();
  const guarded = await adapter.runExclusive(scope, store.walkKey(scope), pass, {
    env,
    ...(opts.deadline ? { deadline: opts.deadline } : {}),
    now,
    purpose: 'acl_refresh',
  });
  if (guarded.busy) return { pages: 0, restamped: 0, missing: 0, skipped: 0, completed: false, busy: true };
  return guarded.value;
}

async function runAclRefresh<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  store: FileIndexingStore,
  env: TEnv,
  scope: FileIndexingScope,
  row: FileIndexingRow,
  opts: {
    deadline?: Deadline;
    now?: () => number;
    maxPages?: number;
    pageHeadroomMs?: number;
    restamp?: RestampFn;
  },
): Promise<AclRefreshOutcome> {
  const now = opts.now ?? Date.now;
  const label = adapter.logLabel ?? DEFAULT_LABEL;
  const ctx = buildContext(env, store, scope, row, opts);
  const restamp = opts.restamp ?? defaultRestamp;
  const headroom = opts.pageHeadroomMs ?? ACL_REFRESH_PAGE_HEADROOM_MS;
  const startLink = row.acl_refresh_link ?? null;
  let link = startLink;
  let completedAt = row.acl_refresh_completed_at ?? null;
  let reset = false;
  const out: AclRefreshOutcome = { pages: 0, restamped: 0, missing: 0, skipped: 0, completed: false };
  const owner = ownerPrincipalOf(adapter, ctx);
  try {
    for (let p = 0; p < (opts.maxPages ?? ACL_REFRESH_MAX_PAGES_PER_TICK); p++) {
      if (opts.deadline && opts.deadline.at - now() <= headroom) break;
      const page = await adapter.aclRefreshPage!(link, ctx);
      if (page.reset) {
        // The pass's continuation expired: start it over; completion time unchanged.
        link = null;
        reset = true;
        out.error = 'acl_refresh_token_expired_reset';
        break;
      }
      out.pages++;
      if (page.entries.length > 0) {
        const resolved = await adapter.resolvePrincipals(page.entries, ctx);
        const patches: Array<{ objectID: string; acl_principals: string[] }> = [];
        for (const entry of page.entries) {
          const id = adapter.objectIdOf(entry, ctx);
          const r = resolved.get(id);
          if (r === undefined || r === 'unresolved' || r === 'denied') {
            out.skipped++;
            continue;
          }
          const principals = owner && !r.includes(owner) ? [...r, owner] : r;
          if (!stampedPrincipalsValid(principals)) {
            out.skipped++;
            continue;
          }
          patches.push({ objectID: id, acl_principals: principals });
        }
        for (let i = 0; i < patches.length; i += MAX_OBJECTS_PER_IMPORT) {
          const chunk = patches.slice(i, i + MAX_OBJECTS_PER_IMPORT);
          const written = await restamp(env, chunk);
          out.restamped += written.updated;
          out.missing += written.skippedMissing;
          // A waiting extraction or content fill imports its stored record
          // whole: give it the principals just written, or its text would
          // land under the old ones (0.1.2). A failure stops the pass here,
          // so this page is re-stamped (and re-synced) next time.
          await syncPendingRecordPrincipals(store, chunk);
        }
      }
      if (!page.hasMore || !page.cursor) {
        link = null;
        completedAt = now();
        out.completed = true;
        break;
      }
      link = page.cursor;
    }
  } catch (err) {
    if (!isDeadlineError(adapter, err)) out.error = errMsg(err);
  }
  if (link !== startLink || out.completed || reset) {
    try {
      await store.setAclRefresh(scope, link, completedAt);
    } catch (err) {
      const detail = `acl_refresh_state_write_failed: ${errMsg(err)}`;
      console.warn(`${label} ${detail}`);
      out.error = out.error ? `${out.error}; ${detail}` : detail;
    }
  }
  return out;
}

// ── row projection + liveness ─────────────────────────────────────────

/** The Actor a stored row belongs to. */
export function actorOfFileRow(row: { sprigr_user_id?: unknown; sprigr_agent_id?: unknown }): Actor {
  const user = typeof row.sprigr_user_id === 'string' && row.sprigr_user_id ? row.sprigr_user_id : undefined;
  const agent = typeof row.sprigr_agent_id === 'string' && row.sprigr_agent_id ? row.sprigr_agent_id : undefined;
  return { ...(user ? { platformUserId: user } : {}), ...(agent ? { agentId: agent } : {}) };
}

/** True while the scope still holds a live grant (adapter.isConnected; true
 *  when the adapter cannot tell). A schedule skips a disconnected scope. */
export async function fileActorStillConnected<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  scope: FileIndexingScope,
  env: TEnv,
): Promise<boolean> {
  return adapter.isConnected ? adapter.isConnected(scope, env) : true;
}

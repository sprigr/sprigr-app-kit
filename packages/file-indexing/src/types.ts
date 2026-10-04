/**
 * Shared types: the env slice the indexer reads, the indexed row shape, and
 * the two seams an app implements (FileSourceAdapter, FileIndexingStore).
 *
 * Everything here is STRUCTURAL so an app's own env type (Ms365Env, GwsEnv,
 * a Dropbox env) is assignable without a cast: every member is optional and
 * typed as a supertype of what the platform wrapper injects. No env, bridge
 * or RESULT type here carries an index signature: an interface (app-sdk's
 * SprigrFilesJobResult, SprigrDataPartialUpdateResult, an app's own env) is
 * never assignable to a type with one, so a single `[key: string]: unknown`
 * breaks the no-cast promise. __tests__/env-compat.test-d.ts pins it.
 */

import type { Actor, D1Like } from '@sprigr/apps-app-sdk';
import type { AclIdentityBridge } from '@sprigr/apps-acl-identity-link';
import type { Deadline } from '@sprigr/apps-fetch-budget';

// ── the env slice ─────────────────────────────────────────────────────

/** `env.SPRIGR.data`, the per-install data-index surface. File indexing uses
 *  only the `withAcl` variants, which target the `-acl-files` index. */
export interface FileIndexingDataApi {
  import(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
    // `index` is never sent by this package (withAcl cannot be combined with
    // it). It is declared so app-sdk's SprigrDataApi, whose import options are
    // `{ index?: string }` with no `withAcl`, still overlaps this type: two
    // all-optional object types with no member in common fail TypeScript's
    // weak-type check, and the SDK-typed env would need a cast.
    opts?: { withAcl?: boolean; index?: string },
  ): Promise<{ indexed?: number }>;
  /** Optional: absent on wrapper builds older than the delete surface. */
  delete?(objectIDs: string[], opts?: { withAcl?: boolean }): Promise<unknown>;
  /** Optional: absent on wrapper builds older than the list-ids surface. */
  listIds?(
    prefix: string,
    opts?: { withAcl?: boolean },
  ): Promise<{ objectIDs: string[]; truncated: boolean }>;
  /** Optional: absent on wrapper builds older than the partial-update route. */
  partialUpdate?(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
    opts?: { withAcl?: boolean; createIfNotExists?: boolean },
  ): Promise<{ updated: number; skippedMissing: number; index: string }>;
}

/** Input to `env.SPRIGR.files.extract` (the platform binary-to-text bridge).
 *  The bytes must already be staged in app storage under `file_key`. */
export interface FilesExtractInput {
  file_key: string;
  format?: ExtractFormat;
  max_chars?: number;
  job_token?: string;
}

/** Result from `env.SPRIGR.files.extract`. */
export interface FilesExtractResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  /** pptx and binaries of 16 MiB or more: a durable async job was dispatched. */
  needs_job?: boolean;
  job_token?: string;
  error?: string;
}

/** Result from `env.SPRIGR.files.job`. */
export interface FilesJobResult {
  status: 'not_found' | 'running' | 'done' | 'error' | string;
  result?: Record<string, unknown>;
}

/** The slice of `env.SPRIGR.files` the extraction bridge uses. */
export interface FileIndexingFilesApi {
  putStream?(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array | string,
    opts?: { contentType?: string; length?: number; filename?: string },
  ): Promise<unknown>;
  extract?(input: FilesExtractInput): Promise<FilesExtractResult>;
  job?(jobToken: string): Promise<FilesJobResult>;
  delete?(key: string, opts?: { owner_ref?: string; ownerless?: boolean }): Promise<unknown>;
}

/** The subset of the app-sdk's SprigrLogEntry the package writes. */
export interface FileIndexingLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** The env the indexer reads. Every app env that carries `SPRIGR` fits. */
export interface FileIndexingEnv {
  SPRIGR?: {
    data?: FileIndexingDataApi;
    files?: FileIndexingFilesApi;
    emit?(event: string, payload: unknown): Promise<unknown>;
    acl?: AclIdentityBridge;
    /** `env.SPRIGR.log` (sprigr-team#7154): one Analytics Engine row per
     *  entry. The pass logs its content-fill outcome through it when present
     *  (0.1.3, sprigr-apps#2725). Structurally the app-sdk's SprigrLogFn. */
    log?(entry: FileIndexingLogEntry): Promise<unknown>;
  };
  SPRIGR_PLATFORM_BASE?: string;
  SPRIGR_INSTALL_TOKEN?: string;
}

// ── the indexed row ───────────────────────────────────────────────────

/**
 * One row of the ACL file index. `acl_principals` must be a non-empty list of
 * valid principals or the WHOLE import batch is rejected. Providers extend it
 * with their own id fields through the type parameter (microsoft-365:
 * `itemId`, `siteId`; google-workspace: `fileId`; dropbox: `fileId`, `rev`).
 */
export type IndexedFileObject<TExt extends Record<string, unknown> = Record<string, unknown>> = {
  /** Stable dedup id, prefixed per provider (`ms:file:`, `gw:file:`, ...). */
  objectID: string;
  acl_principals: string[];
  name?: string;
  path?: string;
  webUrl?: string;
  mimeType?: string;
  /** 'true' | 'false' (string, as both apps already store it). */
  isFolder?: string;
  size?: number;
  driveId?: string;
  source?: string;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  content?: string;
  _keywords?: string;
  [key: string]: unknown;
} & TExt;

export type ExtractFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';

// ── scope and run context ─────────────────────────────────────────────

/**
 * Whose files one pass indexes. google-workspace indexes per actor
 * (`{ actor }`); microsoft-365 per actor AND connection
 * (`{ actor, connectionId }`), because one person can connect two accounts.
 */
export interface FileIndexingScope {
  actor: Actor;
  connectionId?: string;
}

/** What every adapter call receives. */
export interface FileIndexingContext<TEnv extends FileIndexingEnv = FileIndexingEnv> {
  env: TEnv;
  scope: FileIndexingScope;
  actor: Actor;
  /** actorKey(actor): the key microsoft-365 bakes into its objectIDs. */
  key: string;
  /** The store's walk key for this scope (seen-set and lease key). */
  walkKey: string;
  /** The account the indexed files belong to (row.connected_email). */
  ownerEmail: string | undefined;
  /** The row this pass runs from (re-read at the start of the pass). */
  row: FileIndexingRow;
  /** Tick deadline; undefined means unbounded (tests, interactive calls). */
  deadline?: Deadline;
  now: () => number;
}

/** What `runExclusive` receives as its fourth argument. No row: the lease is
 *  taken BEFORE the pass loads the scope's row, which it re-reads under the
 *  lease. */
export interface ExclusiveRunContext<TEnv extends FileIndexingEnv = FileIndexingEnv> {
  env: TEnv;
  /** The tick deadline the pass runs under; undefined means unbounded. A lease
   *  TTL shorter than the time left lets a second invocation in mid-pass. */
  deadline?: Deadline;
  now: () => number;
  /** Which entry point asked: the indexing pass or the permission re-stamp. */
  purpose: 'index' | 'acl_refresh';
}

// ── the source adapter ────────────────────────────────────────────────

/** A removed source item: its objectID plus the `file.deleted` payload fields. */
export interface RemovedFile {
  objectID: string;
  [key: string]: unknown;
}

/**
 * One page of a source listing (a changes page or a full-walk page).
 *
 * Cursor rule, the same for every provider: when `hasMore` is true, `cursor`
 * is the continuation for the NEXT page (Graph nextLink, Drive nextPageToken,
 * a Dropbox cursor with has_more). When `hasMore` is false, `cursor` is the new
 * baseline to resume incremental sync from (Graph deltaLink, Drive
 * newStartPageToken, a Dropbox cursor with has_more false). A page with
 * neither stops the walk with the cursor unmoved.
 */
export interface ChangePage<TEntry> {
  /** Live entries (files and folders) on this page. */
  entries: TEntry[];
  /** Entries the source reports deleted (incremental pages only). */
  removed?: RemovedFile[];
  cursor: string | null;
  hasMore: boolean;
  /** The provider rejected the cursor (Graph/Drive 410, Dropbox `reset`):
   *  the stored cursor is reset and the next run starts a full walk. */
  reset?: boolean;
  /** fullWalk only, for stores with walk-resume columns: the stored listing
   *  continuation was rejected (Drive answers 400). On the first page of a
   *  resumed walk the indexer restarts the walk from the top in the same tick. */
  restartWalk?: boolean;
}

/** Principals for one entry. `'unresolved'` = the permission read failed for a
 *  reason that may pass (throttled, 5xx, a failed batch): skip the file AND
 *  hold the cursor so it is retried (sprigr-apps#2419). `'denied'` = the
 *  source will not show this actor the file's permissions: skip, and let the
 *  cursor move on. Neither ever becomes `public`. */
export type ResolvedPrincipals = string[] | 'unresolved' | 'denied';

/** One extra listing a pass walks besides the main cursor (SharePoint
 *  libraries today, Dropbox team folders later). Re-listed whole every pass:
 *  no cursor, no seen set, no reconcile, no events. */
export interface ExtraScope<TEntry> {
  id: string;
  list(ctx: FileIndexingContext): Promise<TEntry[]>;
}

/** What the indexer reports back after walking the extra scopes. */
export interface ExtraScopesResult {
  /** Scope ids walked to completion, in order. */
  walked: string[];
  /** The first scope NOT started because the deadline was spent, or null. */
  deferredFrom: string | null;
  deferred: number;
  /** One message per scope whose listing failed (403 on a library, ...). */
  errors: string[];
}

export interface ExtraScopePlan<TEntry> {
  scopes: ExtraScope<TEntry>[];
  /** Prefix of the row's `last_error` when a scope fails (microsoft-365:
   *  `sharepoint_drive_failed`). Default `extra_scope_failed`. */
  errorCode?: string;
  /** Called once after the extra scopes are walked and BEFORE the import, so
   *  state such as a discovery cache or a rotation pointer survives an import
   *  failure. Returned fields are merged into the outcome's `extra`. */
  finish?(result: ExtraScopesResult): Promise<Record<string, unknown> | void>;
}

/**
 * The provider seam. Everything provider-specific lives behind it; the walk,
 * stamping, content, import, reconcile, events and cursor discipline live in
 * the package. See README.md for a worked Dropbox adapter.
 */
export interface FileSourceAdapter<TEntry = unknown, TEnv extends FileIndexingEnv = FileIndexingEnv> {
  /** Log prefix, e.g. `[ms-file-indexing]`. Default `[file-indexing]`. */
  readonly logLabel?: string;
  /** Event family prefix: `${eventPrefix}.file.created|updated|deleted`. */
  readonly eventPrefix: string;
  /** Provider id field copied into created/updated payloads (`fileId`, `itemId`). */
  readonly eventIdField?: string;
  /** True when every objectID carries the actor (microsoft-365's
   *  `ms:file:<actorKey>:...`). False when rows are install-scoped
   *  (google-workspace's `gw:file:<fileId>`): the reconcile and the disconnect
   *  purge then delete only when no other actor indexes the install. */
  readonly objectIdsActorScoped: boolean;
  /** `last_error` written when the source rejects the cursor. */
  readonly cursorResetDetail?: string;

  /** The prefix this scope's rows live under. */
  objectIdPrefix(ctx: FileIndexingContext<TEnv>): string;
  /** Prefixes the full-walk reconcile diffs, given the seen set. Default:
   *  `[objectIdPrefix(ctx)]`. microsoft-365 returns one prefix per drive the
   *  walk saw, so SharePoint rows are never diffed. */
  reconcilePrefixes?(seenIds: string[], ctx: FileIndexingContext<TEnv>): string[];
  /** A prefix to sweep from the PLAIN (non-ACL) index on every completed walk
   *  (microsoft-365's pre-0.4 strays). */
  plainIndexSweepPrefix?(ctx: FileIndexingContext<TEnv>): string | null;

  /** Baseline cursor captured BEFORE a full walk starts (Drive
   *  changes.getStartPageToken, Dropbox list_folder/get_latest_cursor). Only
   *  used with a store that has walk-resume columns; otherwise the final
   *  full-walk page's cursor is the baseline. */
  seedCursor?(ctx: FileIndexingContext<TEnv>): Promise<string | null>;
  /** One incremental page from `cursor`. */
  listChanges(cursor: string, ctx: FileIndexingContext<TEnv>): Promise<ChangePage<TEntry>>;
  /** One full-walk page. `pageToken` null = the first page. */
  fullWalk(pageToken: string | null, ctx: FileIndexingContext<TEnv>): Promise<ChangePage<TEntry>>;
  /** Principals per objectID for a batch of live entries. An entry missing
   *  from the map is treated as 'unresolved'. */
  resolvePrincipals(entries: TEntry[], ctx: FileIndexingContext<TEnv>): Promise<Map<string, ResolvedPrincipals>>;
  objectIdOf(entry: TEntry, ctx: FileIndexingContext<TEnv>): string;
  toObject(entry: TEntry, principals: string[], ctx: FileIndexingContext<TEnv>): IndexedFileObject;
  /** The ORIGINAL mime type (an object's `mimeType` is 'folder' for folders and
   *  may be rewritten). Default: the object's `mimeType`. */
  mimeTypeOf?(entry: TEntry): string;
  /** The owner principal every row must carry. Default:
   *  `userPrincipal(ownerEmail)` when the row knows the owner. Appended to a
   *  resolved list that lacks it; never replaces anything. */
  ownerPrincipal?(ctx: FileIndexingContext<TEnv>): string | null;

  /** Text body of a text-like file. Throw or return '' on failure.
   *  `throttled`: the source answered 429; nothing more is asked of that
   *  throttle key this pass and the file waits for a later content fill.
   *  `missing` (0.1.2): the source says the file no longer exists; a pending
   *  content fill for it is dropped instead of retried. */
  downloadText?(
    object: IndexedFileObject,
    ctx: FileIndexingContext<TEnv>,
  ): Promise<string | { text: string; throttled?: boolean; missing?: boolean }>;
  /** Raw bytes of a binary (pdf/docx/xlsx/pptx) for the extract bridge. A
   *  non-ok Response leaves the content empty. */
  downloadBinary?(object: IndexedFileObject, ctx: FileIndexingContext<TEnv>): Promise<Response>;
  /** True for a provider-native format that exports to text (Google Docs). */
  isNativeExportable?(mimeType: string): boolean;
  /** Text export of a provider-native document. */
  exportNative?(object: IndexedFileObject, mimeType: string, ctx: FileIndexingContext<TEnv>): Promise<string>;
  /** Job token for an extraction that may run as a durable job, stable per
   *  file version. See `buildExtractJobToken`. */
  extractJobToken?(
    object: IndexedFileObject,
    format: ExtractFormat,
    version: string | undefined,
    ctx: FileIndexingContext<TEnv>,
  ): Promise<string | undefined>;
  /** Delete a staged extraction copy. Default: `files.delete`, then the SDK's
   *  install-token `deleteAppFile`. */
  deleteStaged?(key: string, ctx: FileIndexingContext<TEnv>): Promise<void>;
  /** Key a 429 throttle applies to (default: the object's driveId). */
  throttleKeyOf?(object: IndexedFileObject): string;
  /** 0.1.3 (sprigr-apps#2725): true when an error `refetchEntry` threw is the
   *  source rate-limiting this pass. The content-fill drain then stops
   *  starting rows on that throttle key for the rest of the pass, and the row
   *  waits without spending one of its attempts. Default: the error carries
   *  `status === 429` (DropboxApiError and GraphApiError both do). */
  isThrottleError?(err: unknown): boolean;
  /** 0.1.2 (sprigr-apps#2702): the source's CURRENT entry for an indexed row,
   *  or null when the file no longer exists. Optional. When present, the
   *  content-fill drain re-reads each waiting file before it fetches text:
   *  a vanished file's fill is dropped, and the row is re-stamped from the
   *  current entry (permissions resolved again, new revision, name and path),
   *  so text is never written under principals the file no longer has. Throw
   *  for a failure that may pass; the fill is retried. Without it the drain
   *  uses the stored record, which every walk that sees the file refreshes. */
  refetchEntry?(object: IndexedFileObject, ctx: FileIndexingContext<TEnv>): Promise<TEntry | null>;

  /** Whether a created/updated event is emitted for this object (default
   *  true; folders never emit). microsoft-365 limits it to OneDrive rows. */
  emitsEventsFor?(object: IndexedFileObject): boolean;
  /** Claim a `file.deleted` emit (a cross-invocation dedup latch). False =
   *  another path already emitted it. Called right before the emit. */
  claimDeletedEvent?(objectID: string, ctx: FileIndexingContext<TEnv>): Promise<boolean>;
  /** Give a claim back when the emit failed, so a later run can emit it. */
  releaseDeletedEvent?(objectID: string, ctx: FileIndexingContext<TEnv>): Promise<void>;

  /** Extra listings for this pass (SharePoint, team folders). */
  extraScopes?(ctx: FileIndexingContext<TEnv>): Promise<ExtraScopePlan<TEntry> | null>;
  /** Serialise passes per scope (microsoft-365's D1 lease). `busy` = another
   *  invocation holds it; the pass does nothing.
   *
   *  `run` (0.1.1, sprigr-app-kit#99) carries the env and the tick deadline,
   *  so an adapter whose lease lives in the app's D1 reaches `run.env.DB`
   *  without building one adapter per env. Optional to read: an adapter that
   *  declares only the first three parameters keeps working unchanged. */
  runExclusive?<T>(
    scope: FileIndexingScope,
    walkKey: string,
    fn: () => Promise<T>,
    run: ExclusiveRunContext<TEnv>,
  ): Promise<{ busy: true; purgePending?: boolean } | { busy: false; value: T }>;
  /** Fill a missing owner email (google-workspace asks Drive). A found email
   *  is stored and the cursor reset, so every row is re-stamped with it. */
  resolveOwnerEmail?(ctx: FileIndexingContext<TEnv>): Promise<string | null>;
  /** True while this scope still holds a live grant. */
  isConnected?(scope: FileIndexingScope, env: TEnv): Promise<boolean>;
  /** Prefixes a disconnect purges. Default `[objectIdPrefix(ctx)]`. */
  purgePrefixes?(ctx: FileIndexingContext<TEnv>): Promise<string[]>;

  /** sprigr-apps#2211: an IDs-and-parents enumeration of the whole source on
   *  its OWN continuation, for the permission re-stamp pass. Opt-in: an adapter
   *  whose change feed already reports sharing changes leaves it out. */
  aclRefreshPage?(link: string | null, ctx: FileIndexingContext<TEnv>): Promise<ChangePage<TEntry>>;

  /** True when a thrown error means "the tick deadline cut this call"; the
   *  pass then keeps what it collected instead of recording an error. Default:
   *  a `FetchBudgetTimeoutError` with phase 'budget'. */
  isDeadlineError?(err: unknown): boolean;
}

// ── the store ─────────────────────────────────────────────────────────

/** A file-indexing row, normalised over the per-app column names. */
export interface FileIndexingRow {
  enabled: number;
  /** The provider cursor (gw `page_token`, ms `delta_link`). */
  cursor: string | null;
  connected_email: string | null;
  full_walk_active: number;
  /** Listing continuation of an in-progress full walk (stores with resume columns). */
  walk_list_token: string | null;
  /** Baseline captured when the full walk began (stores with resume columns). */
  walk_start_token: string | null;
  identity_link_refused_at: number | null;
  unresolved_held_since: number | null;
  acl_refresh_link: string | null;
  acl_refresh_completed_at: number | null;
  last_indexed_at: number | null;
  last_status: string | null;
  last_error: string | null;
  files_indexed: number;
  files_skipped: number;
  /** The row exactly as D1 returned it (app-specific columns live here). */
  raw: Record<string, unknown>;
}

export interface PendingExtractionRow {
  object_id: string;
  job_token: string;
  record_json: string;
  format: string;
  attempts: number;
  created_at: number;
  updated_at: number;
}

/** Durable state for one app's file indexing. `createD1FileIndexingStore`
 *  implements it over the apps' existing tables. */
export interface FileIndexingStore {
  /** Capabilities, decided by which columns the app's schema has. */
  readonly hasWalkResumeColumns: boolean;
  readonly hasHeldSinceColumn: boolean;
  readonly hasAclRefreshColumns: boolean;

  walkKey(scope: FileIndexingScope): string;
  load(scope: FileIndexingScope): Promise<FileIndexingRow | null>;
  listEnabled(): Promise<Array<{ scope: FileIndexingScope; row: FileIndexingRow }>>;
  enable(scope: FileIndexingScope, opts: { connectedEmail: string | null; extra?: Record<string, unknown> }): Promise<void>;
  disable(scope: FileIndexingScope): Promise<boolean>;
  remove(scope: FileIndexingScope): Promise<void>;
  /** Rows (enabled or not) of actors other than this scope's actor. */
  countOtherActors(scope: FileIndexingScope): Promise<number>;

  recordSuccess(scope: FileIndexingScope, cursor: string | null, indexed: number, skipped: number): Promise<void>;
  recordWalkProgress(
    scope: FileIndexingScope,
    progress: { listToken: string | null; startToken: string | null; indexed: number; skipped: number },
  ): Promise<void>;
  recordError(scope: FileIndexingScope, error: string): Promise<void>;
  resetCursor(scope: FileIndexingScope): Promise<void>;
  setIdentityLinkRefused(scope: FileIndexingScope, refusedAt: number | null): Promise<void>;
  setConnectedEmail(scope: FileIndexingScope, email: string): Promise<void>;
  setFullWalkActive(scope: FileIndexingScope, active: boolean): Promise<void>;
  setUnresolvedHeldSince(scope: FileIndexingScope, since: number | null): Promise<void>;
  setAclRefresh(scope: FileIndexingScope, link: string | null, completedAt: number | null): Promise<void>;

  recordWalkSeen(walkKey: string, objectIds: string[]): Promise<void>;
  listWalkSeen(walkKey: string): Promise<string[]>;
  clearWalkSeen(walkKey: string): Promise<void>;

  upsertPendingExtraction(row: { objectId: string; jobToken: string; recordJson: string; format: string }): Promise<void>;
  /** Oldest first. Content-fill rows (`CONTENT_FILL_TOKEN_PREFIX`) are not
   *  extraction jobs: createD1FileIndexingStore leaves them out, and
   *  drainPendingExtractions skips any a custom store returns. */
  listPendingExtractions(limit: number): Promise<PendingExtractionRow[]>;
  /** `job_token` is returned by createD1FileIndexingStore since 0.1.2; a store
   *  that leaves it out still works (an unknown token is treated as a job,
   *  so a content fill never overwrites it). */
  listPendingExtractionsFor(
    objectIds: string[],
  ): Promise<Array<Pick<PendingExtractionRow, 'object_id' | 'record_json'> & { job_token?: string }>>;
  refreshPendingExtractionRecord(objectId: string, recordJson: string): Promise<void>;
  bumpPendingExtraction(objectId: string): Promise<void>;
  deletePendingExtraction(objectId: string): Promise<void>;
  deletePendingExtractions(objectIds: string[]): Promise<void>;

  // ── content fills (0.1.2, sprigr-apps#2702) ──
  // Rows in the same pending table whose job_token is a content-fill token
  // (`contentFillToken(walkKey)`): files a pass imported without their text
  // because it stopped at the deadline, the extraction cap or a 429. Optional
  // so a hand-written store keeps compiling; without `listPendingContentFills`
  // nothing is recorded (there would be no drain) and the pass behaves as
  // 0.1.1 did. createD1FileIndexingStore implements all four.

  /** Upsert many rows at once (a deadline cut can defer hundreds). Falls back
   *  to one upsertPendingExtraction per row when absent. */
  upsertPendingContentFills?(rows: Array<{ objectId: string; jobToken: string; recordJson: string; format: string }>): Promise<void>;
  /** Rows carrying exactly this token, least recently touched first. */
  listPendingContentFills?(jobToken: string, limit: number): Promise<PendingExtractionRow[]>;
  countPendingContentFills?(jobToken: string): Promise<number>;
  deletePendingContentFills?(jobToken: string): Promise<void>;
}

export type { Actor, D1Like, Deadline };

/**
 * @sprigr/apps-file-indexing
 *
 * The shared file-indexing loop for marketplace apps that mirror a cloud
 * drive into the platform's ACL-enforced file index (`-acl-files`):
 * microsoft-365 (OneDrive + SharePoint), google-workspace (Google Drive) and
 * dropbox. An app implements a FileSourceAdapter (the provider calls) and
 * builds a FileIndexingStore over its own D1 tables; the package owns the
 * principal grammar, the walk, fail-closed stamping, content extraction, the
 * validated withAcl import, the reconcile, events, the disconnect purge and
 * the permission re-stamp.
 *
 * Why one package: sprigr-team decision 0151
 * (docs/decisions/proposed/0151-cloud-storage-apps-share-one-file-indexing-package-behind-a-file-source-adapter.md).
 *
 *   const store = createD1FileIndexingStore(env.DB, GOOGLE_WORKSPACE_STORE_CONFIG);
 *   for (const { scope } of await store.listEnabled()) {
 *     await indexActorFiles(driveAdapter, store, env, scope, { deadline });
 *   }
 *   await drainPendingExtractions(store, env);
 *
 * Files a pass could not fetch text for (deadline, extraction cap, 429) are
 * queued and filled by later passes of the same scope (0.1.2, content-fill.ts);
 * `outcome.contentPending` says how many still wait.
 */

export {
  PUBLIC_PRINCIPAL,
  ACL_PRINCIPALS_ATTR,
  userPrincipal,
  groupPrincipal,
  orgPrincipal,
  isValidPrincipal,
  normalizePrincipal,
  stampedPrincipalsValid,
} from './doc-acl';

export {
  MAX_CONTENT_BYTES,
  MAX_CONTENT_CHARS,
  MAX_EXTRACT_INLINE_BYTES,
  MAX_EXTRACTIONS_PER_RUN,
  DURABLE_EXTRACT_FORMATS,
  EXTRACT_STAGING_PREFIX,
  CONTENT_TRUNCATION_MARKER,
  extractFormatForMime,
  isTextLikeMimeType,
  capText,
  buildExtractJobToken,
  extractBinaryFileContent,
  enrichObjectsWithContent,
  contentKindFor,
  fetchObjectContent,
} from './content';
export type { BinaryExtractResult, ExtractionBudget, EnrichSummary, ContentKind, ContentFetch } from './content';

export {
  CONTENT_FILL_TOKEN_PREFIX,
  CONTENT_FILL_BUDGET_MS,
  IDLE_CONTENT_FILL_BUDGET_MS,
  CONTENT_FILL_CONCURRENCY,
  CONTENT_FILL_IMPORT_CHUNK,
  MAX_CONTENT_FILLS_PER_PASS,
  MAX_CONTENT_FILL_ATTEMPTS,
  contentFillToken,
  isContentFillToken,
  storeSupportsContentFills,
  recordContentFills,
  countPendingContentFills,
  describeContentPending,
  drainContentFills,
} from './content-fill';
export type { ContentFillOptions, ContentFillOutcome } from './content-fill';

export { MAX_OBJECTS_PER_IMPORT, importFileObjects, partitionValidObjects } from './import';

export { emitFileEvents, fileEventNames } from './events';
export type { FileEvent, EmitOutcome } from './events';

export {
  MAX_EXTRACTION_POLLS_PER_RUN,
  MAX_EXTRACTION_ATTEMPTS,
  SLOW_EXTRACTION_POLL_MS,
  drainPendingExtractions,
  refreshPendingExtractions,
  forgetPendingExtractions,
  syncPendingRecordPrincipals,
} from './pending';
export type { DrainOptions } from './pending';

export {
  INDEX_FILES_BUDGET_MS,
  EXTRACTION_DRAIN_BUDGET_MS,
  EMIT_BUDGET_MS,
  MIN_ITEM_BUDGET_MS,
  DEFAULT_FETCH_CONCURRENCY,
  TickBudget,
  mapWithConcurrency,
  createDeadline,
  remainingBudgetMs,
  deadlinePassed,
  budgetBelow,
} from './tick-budget';

export {
  MAX_WALK_PAGES,
  IDENTITY_LINK_BACKOFF_MS,
  MAX_UNRESOLVED_HOLD_MS,
  PURGE_DELETE_CHUNK,
  MIN_PURGE_LEG_MS,
  ACL_REFRESH_INTERVAL_MS,
  ACL_REFRESH_MAX_PAGES_PER_TICK,
  ACL_REFRESH_PAGE_HEADROOM_MS,
  indexActorFiles,
  reconcileWalk,
  countIndexedItems,
  purgeIndexPrefix,
  purgeActor,
  aclRefreshDue,
  refreshAclPrincipals,
  actorOfFileRow,
  fileActorStillConnected,
  buildContext,
} from './indexer';
export type { IndexActorFilesBudget, FileIndexingOutcome, PurgeActorResult, PurgePrefixResult, AclRefreshOutcome } from './indexer';

export {
  createD1FileIndexingStore,
  defaultRedact,
  GOOGLE_WORKSPACE_STORE_CONFIG,
  MICROSOFT_365_STORE_CONFIG,
  DEFAULT_FILE_INDEXING_STORE_CONFIG,
  DEFAULT_FILE_INDEXING_SCHEMA_SQL,
} from './d1-store';
export type { D1FileIndexingStoreConfig } from './d1-store';

export type {
  Actor,
  D1Like,
  Deadline,
  FileIndexingEnv,
  FileIndexingLogEntry,
  FileIndexingDataApi,
  FileIndexingFilesApi,
  FilesExtractInput,
  FilesExtractResult,
  FilesJobResult,
  IndexedFileObject,
  ExtractFormat,
  FileIndexingScope,
  FileIndexingContext,
  RemovedFile,
  ChangePage,
  ResolvedPrincipals,
  ExtraScope,
  ExtraScopesResult,
  ExtraScopePlan,
  ExclusiveRunContext,
  FileSourceAdapter,
  FileIndexingRow,
  PendingExtractionRow,
  FileIndexingStore,
} from './types';

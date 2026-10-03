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
} from './content';
export type { BinaryExtractResult, ExtractionBudget, EnrichSummary } from './content';

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
export type { IndexActorFilesBudget, FileIndexingOutcome, PurgeActorResult, AclRefreshOutcome } from './indexer';

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
  FileSourceAdapter,
  FileIndexingRow,
  PendingExtractionRow,
  FileIndexingStore,
} from './types';

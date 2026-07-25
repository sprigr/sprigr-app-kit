/**
 * @sprigr/apps-app-sdk
 *
 * Shared types and helpers for marketplace-app handlers in this repo.
 */

export { constantTimeEqual, hmacSha256Hex, randomHex } from './crypto';
export { encodeState, decodeState } from './state';
export type { OAuthState } from './state';
export { fetchWithRetry } from './fetch';
export type { FetchWithRetryOptions } from './fetch';
export {
  bytesToBase64,
  base64ToBytes,
  fetchFileBytes,
  fetchFileAsBase64,
  DEFAULT_MAX_FILE_BYTES,
} from './file';
export type { FetchFileResult } from './file';
export { resolvePlatformWebhookBase, buildMarketplaceWebhookUrl } from './platform-host';
export type { PlatformHostEnv } from './platform-host';
export {
  emitMarketplaceEvent,
  createMarketplaceEmitter,
  canEmit,
  withSprigrEmitFallback,
  resolveInstallBridge,
  describeMissingBridge,
  installTokenPost,
  overlaySprigr,
  DEFAULT_EMIT_TIMEOUT_MS,
} from './wfp-bridge';
export type {
  EmitResult,
  EmitTransport,
  EmitMarketplaceEventOptions,
  InstallBridge,
  WfpBridgeEnv,
  WfpEmitReply,
} from './wfp-bridge';
export { parseActor, actorKey } from './actor';
export type { Actor } from './actor';
export {
  putAppFile,
  putAppFileStream,
  appFileUrl,
  getAppFile,
  listAppFiles,
  deleteAppFile,
} from './app-files';
export type {
  AppFilesEnv,
  PutAppFileArgs,
  PutAppFileResult,
  PutAppFileStreamArgs,
  AppFileUrlArgs,
  AppFileUrlResult,
  GetAppFileResult,
  AppFileListItem,
} from './app-files';

/**
 * Identifies the upstream third-party integration that sourced a
 * bridged marketplace event. Apps that wrap a provider webhook
 * (Shopify orders, Procore RFI updates, ...) stamp this on each
 * emit so subscribers can call write-backs through the platform's
 * per-integration forwarder.
 *
 * Mirrors the platform-side `MarketplaceEventSourceIntegration`
 * type in the Sprigr platform source. Keep
 * the field set + nullability in sync — the queue-consumer's
 * marketplace-event-handler reads these unconditionally on the
 * dispatch path, so a missing `integrationId` or `integrationType`
 * is a hard error (400 from /internal/wfp/emit).
 */
export interface MarketplaceEventSourceIntegration {
  /** Stable identifier for the source integration. For marketplace-
   *  bridged events, this is typically the source app's INSTALL_ID. */
  integrationId: string;
  /** Integration type / slug (e.g. 'shopify'). Matches the manifest's
   *  `integration_dependencies[].integration_type` so the platform
   *  forwarder can route write-backs by type. */
  integrationType: string;
  /** Optional human-friendly identifier (e.g. Shopify shop domain
   *  `brand-a.myshopify.com`). Useful for app-side logging / display;
   *  use `integrationId` for routing. */
  shopDomain?: string;
  /** Opaque service key the marketplace app supplied when it
   *  registered a FulfillmentService (or equivalent per-resource
   *  partition). Set ONLY when the event is scoped to one
   *  registration; absent for shop-wide events. */
  fulfillmentServiceKey?: string;
}

/**
 * Optional metadata forwarded with `env.SPRIGR.emit`. The platform-
 * side `/internal/wfp/emit` endpoint passes each field through to
 * `emitMarketplaceEvent`.
 */
export interface MarketplaceEventEmitOpts {
  /** Stable identifier for the source integration; see
   *  MarketplaceEventSourceIntegration. */
  sourceIntegration?: MarketplaceEventSourceIntegration;
  /** Pin delivery to a single install in the receiving tenant.
   *  Omit for broadcast (the default). */
  targetAppInstallationId?: string;
  /** Reserved for future at-least-once dedup. Apps can set it now;
   *  the platform stores it but doesn't enforce dedup yet. */
  dedupId?: string;
}

/**
 * Options for `env.SPRIGR.data.search`. Mirrors the platform's
 * /internal/wfp/data/search body (the platform provisioning worker). All fields optional; an
 * empty call returns the first page of everything.
 */
export interface SprigrDataSearchOpts {
  /** Full-text query. Combine with `semantic: true` for hybrid search. */
  query?: string;
  /** Facet filter string, e.g. 'status:active,type:customer'. */
  filters?: string;
  /** Hybrid keyword + vector search. Best for fuzzy human references. */
  semantic?: boolean;
  /** Sort expression, e.g. 'updatedAt:desc'. */
  sortBy?: string;
  /** Facet names to count in the response. */
  facets?: string[];
  /** Restrict returned fields to keep responses lean. */
  attributesToRetrieve?: string[];
  /** Zero-based page. Default 0. */
  page?: number;
  /** Results per page. Default 20, platform-clamped to 100. */
  hitsPerPage?: number;
}

export interface SprigrDataSearchResult {
  ok: boolean;
  hits: Array<{ objectID: string; [key: string]: unknown }>;
  nbHits: number;
  page: number;
  facetCounts?: Record<string, Record<string, number>>;
  /** The private index that was queried (informational). */
  index: string;
}

/**
 * The marketplace install's PRIVATE per-company datastore: a Sprigr
 * index named `<companyId>-app-<slug>`, reachable only through these
 * methods (agents have no direct index access). Injected on
 * `env.SPRIGR` by the platform wrapper for /__sprigr/* dispatch.
 *
 * Intended pattern: the app syncs lean provider objects via `import`,
 * its tool handlers call `search` to resolve a fuzzy human reference
 * ("customer Joe Bloggs") to an entity ID, then fetch live detail from
 * the provider REST API by that ID. The index is a resolver, not a
 * cache of record.
 */
export interface SprigrDataApi {
  /**
   * Upsert objects into the private index. Each object MUST carry a
   * unique string `objectID`. The index is auto-created on first
   * import from the manifest's `data_index` settings; re-imports
   * upsert by objectID. Max 1000 objects per call.
   */
  import(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
  ): Promise<{ ok: boolean; indexed: number; index: string }>;
  /**
   * Search the private index. A never-imported index yields an empty
   * hit list, not an error.
   */
  search(opts?: SprigrDataSearchOpts): Promise<SprigrDataSearchResult>;
  /** Fetch one object by objectID. `object` is null when absent. */
  get(
    objectID: string,
  ): Promise<{ ok: boolean; object: Record<string, unknown> | null; index: string }>;
}

/**
 * Durable app file storage exposed on `env.SPRIGR.files` by the platform
 * wrapper (the platform build-runner). Persists bytes into the install's
 * contained R2 namespace (every key is confined server-side to
 * `_apps/{installId}/...`, so an app can only ever touch its own files) and
 * mints signed, time-limited download URLs.
 *
 * Use it to re-host an ephemeral third-party asset (e.g. a provider render
 * URL the upstream deletes after a short retention window) so the URL your
 * app hands back keeps resolving.
 *
 * This is the in-isolate bridge surface, injected on `env.SPRIGR` for
 * `/__sprigr/*` tool / webhook / event handlers. The standalone
 * `putAppFileStream` / `appFileUrl` helpers in this package call the same
 * `/internal/wfp/file/*` endpoints over HTTP for code that runs outside the
 * injected bridge (e.g. inline Next.js route handlers).
 */
export interface SprigrFilesApi {
  /**
   * Stream bytes into the app's store under `key` (app-relative; the platform
   * adds/strips the `_apps/{installId}/` prefix). A `ReadableStream` is piped
   * straight through to R2 without buffering whole in the isolate, so use it
   * for multi-MB blobs (videos, full-res photos, PDFs). Size cap: 50 MB.
   * `opts.length` declares the byte length so the platform can enforce the cap
   * before opening the write; forward it for streamed bodies, which carry no
   * Content-Length (`bytes` comes back `null` when it is omitted).
   */
  putStream(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array | string,
    opts?: { contentType?: string; length?: number; filename?: string },
  ): Promise<{ ok: boolean; key: string; bytes: number | null; contentType: string }>;
  /**
   * Mint a signed, time-limited download URL for a previously-stored `key`.
   * `opts.expiresIn` is seconds, clamped server-side (default 24h, min 60s,
   * max ~10y). The URL expires, so re-mint on demand rather than caching it.
   */
  url(
    key: string,
    opts?: { expiresIn?: number },
  ): Promise<{ ok: boolean; url: string; expires_at: number; key: string }>;
}

/**
 * Platform document-engine bridge types (`env.SPRIGR.files.edit` / `.create`
 * / `.job`). Canonical declaration: previously copied consumer-side into
 * microsoft-365 and google-workspace to avoid a repo-wide vendor re-sync;
 * upstreamed here once two live consumers shipped (m365 0.15/0.16,
 * google-workspace 0.4).
 */

/** Input to `env.SPRIGR.files.edit` (the platform surgical document edit bridge). */
export interface SprigrFilesEditInput {
  /** App-relative key of the source file already in app storage. */
  file_key: string;
  /** pdf runs the PyMuPDF ops engine (list_fields / fill_form / replace_text);
   *  docx/xlsx run python-docx / openpyxl; xer/pmxml/mspdi run the platform's
   *  pure-TS schedule engine in-worker (Primavera P6 / MS Project XML, no
   *  sandbox cold-start exposure). */
  format: 'docx' | 'xlsx' | 'pdf' | 'xer' | 'pmxml' | 'mspdi';
  operations: Array<Record<string, unknown>>;
  output_filename?: string;
  output_key?: string;
  allow_lossy?: boolean;
  /** Schedule formats only: write even when the FK-integrity gate finds
   *  errors (the validation result is still returned). */
  skip_validation?: boolean;
  /** Deterministic idempotency token: the platform persists the pipeline's
   *  terminal result under it, so a retry of the same logical edit after a
   *  dispatch timeout replays the finished result instead of re-running the
   *  engine. Filename-safe: ^[A-Za-z0-9_-]{8,128}$. */
  job_token?: string;
}

/** Result from `env.SPRIGR.files.edit`. */
export interface SprigrFilesEditResult {
  ok: boolean;
  out_file_key?: string;
  size?: number;
  operations_applied?: Array<Record<string, unknown>>;
  failed_operations?: Array<Record<string, unknown>>;
  warning?: string;
  error?: string;
  /** Schedule formats only: the FK-integrity result ({errorCount, warningCount, issues}). */
  validation?: Record<string, unknown>;
  /** Schedule formats only: one-line engine summary incl. matched counts. */
  summary?: string;
}

/** Input to `env.SPRIGR.files.create` (build a NEW docx/xlsx from a spec). */
export interface SprigrFilesCreateInput {
  format: 'docx' | 'xlsx';
  /** docx: content blocks (heading/paragraph/table/…). xlsx: sheet defs ({name, headers, rows, …}). */
  spec: Array<Record<string, unknown>>;
  properties?: Record<string, unknown>;
  output_filename?: string;
  output_key?: string;
  /** Same idempotency semantics as SprigrFilesEditInput.job_token. */
  job_token?: string;
}

/** Result from `env.SPRIGR.files.create`. */
export interface SprigrFilesCreateResult {
  ok: boolean;
  out_file_key?: string;
  size?: number;
  error?: string;
}

/** Result from `env.SPRIGR.files.job` (read-only job-record status). */
export interface SprigrFilesJobResult {
  ok: boolean;
  job_token: string;
  status: 'not_found' | 'running' | 'done' | 'error';
  /** True when the record is older than the platform's freshness windows
   *  (an orphaned `running` or an expired terminal record). */
  stale?: boolean;
  started_at?: number;
  finished_at?: number;
  http_status?: number;
  /** The stored edit/create response body (terminal records only). */
  result?: Record<string, unknown>;
}

/** The platform files bridge plus the document-engine methods. */
export interface SprigrFilesApiWithEdit extends SprigrFilesApi {
  edit(input: SprigrFilesEditInput): Promise<SprigrFilesEditResult>;
  create(input: SprigrFilesCreateInput): Promise<SprigrFilesCreateResult>;
  /** Optional: absent on wrapper builds older than the job-token surface;
   *  callers must feature-detect. */
  job?(jobToken: string): Promise<SprigrFilesJobResult>;
}

/** Narrow structural type for the per-install D1 binding. */
export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...args: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface WebhookArgs {
  body: string;
  signature?: string;
  headers?: Record<string, string>;
}

export interface ScheduleArgs {
  name: string;
  scheduled_at?: string;
}

export interface EventArgs {
  event: string;
  payload: unknown;
  eventId: string;
}

/**
 * ExecutionContext shape narrowed to what most handlers need
 * (`waitUntil` for fire-and-forget tasks). Keeps the type usable
 * without depending on @cloudflare/workers-types here.
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export type HandlerFn<TArgs, TResult> = (
  args: TArgs,
  env: Record<string, unknown>,
  ctx?: ExecutionContextLike,
) => Promise<TResult>;

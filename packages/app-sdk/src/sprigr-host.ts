/**
 * Types for the `env.SPRIGR` namespaces the platform wrapper serves but the
 * SDK did not type: usage, acl, connect, integrations, run_workflow, browser,
 * schedules, store, collections, fulfillment_services and ftp (#247).
 *
 * Field names are spelled as the wrapper and the platform route read them.
 * A misspelled key is dropped on the wire rather than refused, so the types
 * are the only check an app gets. Results the wrapper passes through without
 * shaping are typed with the fields the platform documents and stay open.
 *
 * Unless noted, a method rejects on failure with an Error carrying `code`
 * (the platform's `error`, or a per-method fallback) and `status`.
 */

/** A platform JSON body the wrapper returns as-is. */
export type SprigrPlatformBody = Record<string, unknown>;

// ---------------------------------------------------------------- usage

export interface SprigrUsageReportInput {
  /** Finite and above 0; sent rounded. */
  billedTokens: number;
  kind?: string;
  model?: string;
  meta?: Record<string, unknown>;
  /** Idempotency key, 1-512 chars: a retry with the same id is billed once and
   *  answers `deduped: true`. Anything else, `null` included, is refused 400. */
  dedupId?: string;
}

export interface SprigrUsageApi {
  /** POST /internal/wfp/usage. Rejects with a plain Error (no `code`) on failure. */
  report(input: SprigrUsageReportInput): Promise<SprigrPlatformBody | null>;
}

// ---------------------------------------------------------------- acl

export interface SprigrAclOwner {
  kind: 'user' | 'agent';
  id: string;
}

export interface SprigrAclApi {
  linkIdentity(owner: SprigrAclOwner, email: string): Promise<SprigrPlatformBody>;
  unlinkIdentity(owner: SprigrAclOwner, email?: string): Promise<SprigrPlatformBody>;
  setGroups(owner: SprigrAclOwner, groupIds: string[]): Promise<SprigrPlatformBody>;
}

// ---------------------------------------------------------------- connect

export interface SprigrConnectCheckAgentBindOpts {
  accountKey?: string;
  personalConnectionOf?: string[];
}

export interface SprigrConnectCompleteInput {
  /** The raw `X-Sprigr-Viewer` header the page request carried. */
  viewer_token: string;
  /** Omitted means the signed-in user. Binding to an agent needs an admin. */
  bind?: { kind: 'user' } | { kind: 'agent'; agent_id: string };
  account: { email: string; name?: string };
  identities?: Array<{ email: string; name?: string }>;
}

export interface SprigrConnectDisconnectInput {
  /** `u:<userId>` or `a:<agentId>`, as `complete` returned it. */
  actor_key: string;
  account_email?: string;
}

export interface SprigrConnectApi {
  checkAgentBind(agentId: string, email: string, opts?: SprigrConnectCheckAgentBindOpts): Promise<SprigrPlatformBody & { allowed: boolean }>;
  complete(input: SprigrConnectCompleteInput): Promise<SprigrPlatformBody & { ok?: boolean; actor_key?: string }>;
  disconnect(input: SprigrConnectDisconnectInput): Promise<SprigrPlatformBody>;
}

// ---------------------------------------------------------------- integrations

export interface SprigrIntegrationsInvokeInput {
  /** Integration type slug. Sent as `integrationType`. */
  type: string;
  integrationId: string;
  /** Tool name. Sent as `toolName`. */
  tool: string;
  /** Use `{}` for no arguments; an array is refused. */
  args: Record<string, unknown>;
}

export interface SprigrIntegrationsApi {
  /** Resolves the tool's result. Codes include no_grant, grant_not_live, integration_not_found and integrations_invoke_timeout. */
  invoke(input: SprigrIntegrationsInvokeInput): Promise<unknown>;
}

// ---------------------------------------------------------------- run_workflow

export interface SprigrRunWorkflowOpts {
  /** Defaults to null. */
  input?: unknown;
  /** Clamped to 100..5000; default 2000. */
  timeout_ms?: number;
  decision_point?: string;
}

/** Never rejects for a platform refusal: resolves `ok: false` with `error` instead. */
export type SprigrRunWorkflow = (workflowId: string, opts?: SprigrRunWorkflowOpts) => Promise<SprigrPlatformBody & { ok: boolean; error?: string; status?: number }>;

// ---------------------------------------------------------------- browser

export interface SprigrBrowserFetchOpts {
  evaluate?: string;
  referer?: string | null;
  humanize?: boolean;
  waitForSelector?: string;
  timeoutMs?: number;
}

/** A remote browser session. Publisher-owner installs only (403 not_publisher_owner). */
export interface SprigrBrowserSessionApi {
  open(input?: Record<string, unknown>): Promise<SprigrPlatformBody>;
  /** Throws synchronously when `sessionId` is missing. */
  act(input: { sessionId: string; action: string } & Record<string, unknown>): Promise<SprigrPlatformBody>;
  snapshot(input: { sessionId: string; kind?: 'snapshot' | 'content' | 'screenshot' }): Promise<SprigrPlatformBody>;
  /** Throws synchronously when `cookieKey` is missing. */
  cookies(input: { cookieKey: string; op: 'seed' | 'save' | 'load'; sessionId?: string; cookies?: unknown[] }): Promise<SprigrPlatformBody>;
  close(input: { sessionId: string }): Promise<SprigrPlatformBody>;
}

export interface SprigrBrowserApi {
  /** Needs the `sprigr.browser:fetch` scope (403 scope_not_granted). */
  fetch(url: string, opts?: SprigrBrowserFetchOpts): Promise<SprigrPlatformBody>;
  screenshot(url: string, opts?: { fullPage?: boolean }): Promise<SprigrPlatformBody>;
  session: SprigrBrowserSessionApi;
}

// ---------------------------------------------------------------- schedules

interface SprigrScheduleCreateBase {
  name: string;
  /** Defaults to 'message'. 'pipe' is refused. */
  taskType?: 'message' | 'reminder' | 'script';
  /** Required when taskType is 'message'. */
  prompt?: string;
  agentSlug?: string;
  reminderMessage?: string;
  notifyChannel?: 'webchat' | 'whatsapp' | 'telegram' | 'none';
  scriptPath?: string;
  timezone?: string;
  enabled?: boolean;
}

/** Exactly one of `cron` or `fireAt`; any other field is refused with unsupported_field. */
export type SprigrScheduleCreateInput =
  | (SprigrScheduleCreateBase & { cron: string; fireAt?: never })
  | (SprigrScheduleCreateBase & { fireAt: string; cron?: never });

export interface SprigrSchedulesApi {
  /** Idempotent on `name`: a repeat returns the existing schedule with `existing: true`. */
  create(input: SprigrScheduleCreateInput): Promise<SprigrPlatformBody & { scheduleId: string; agentSlug: string; existing: boolean }>;
}

// ---------------------------------------------------------------- store

export type SprigrStoreScope = 'company' | 'publisher';

export interface SprigrStoreApi {
  /** Resolves null for a missing key. */
  get(key: string, opts?: { scope?: SprigrStoreScope }): Promise<string | null>;
  put(key: string, value: string, opts?: { scope?: SprigrStoreScope; ttlSeconds?: number }): Promise<SprigrPlatformBody>;
  delete(key: string, opts?: { scope?: SprigrStoreScope }): Promise<SprigrPlatformBody>;
  /** Resolves the key names. */
  list(opts?: { scope?: SprigrStoreScope; prefix?: string }): Promise<string[]>;
}

// ---------------------------------------------------------------- collections

export interface SprigrCollectionField {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'enum' | 'date';
  facet?: boolean;
  searchable?: boolean;
  required?: boolean;
  values?: string[];
  unit?: string;
}

export type SprigrCollectionNormalizeOp = 'lower' | 'upper' | 'trim' | 'collapse_ws' | 'strip_nonalnum';

export interface SprigrCollectionDefineInput {
  scope: 'private' | 'company';
  /** Lowercase slug, max 64, not starting with "acl". */
  name_suffix: string;
  description: string;
  key: { strategy: 'composite' | 'natural' | 'surrogate'; fields?: string[]; normalize?: SprigrCollectionNormalizeOp[] };
  fields: SprigrCollectionField[];
  searchable?: string[];
  sort_by?: string[];
  history?: boolean;
  acl?: { enabled: boolean; user_fields?: string[]; group_fields?: string[]; public?: boolean };
  lifetime?:
    | { ttl_days: number }
    | { expire_on: 'conversation_archived'; conversation_id: string; ttl_days?: number }
    | { permanent: true };
  system?: boolean;
}

export interface SprigrCollectionSource {
  extractor?: string;
  file_key?: string;
}

export interface SprigrCollectionIngestInput {
  collection: string;
  records: Record<string, unknown>[];
  merge_policy?: 'last_write_wins' | 'merge' | 'conflict_hold';
  source?: SprigrCollectionSource;
}

export interface SprigrCollectionIngestFromTableInput {
  collection: string;
  rows: Record<string, unknown>[];
  mapping: Record<string, unknown>;
  constant_fields?: Record<string, unknown>;
  source?: SprigrCollectionSource;
}

export interface SprigrCollectionQueryInput {
  collection: string;
  query?: string;
  filters?: string;
  facets?: string[];
  sort_by?: string;
  page?: number;
  /** 1..100, default 20. */
  hits_per_page?: number;
  attributes_to_retrieve?: string[];
}

export interface SprigrCollectionReconcileInput {
  collection: string;
  against: { records: Record<string, unknown>[] } | { collection: string };
  match: { key: string | string[]; normalize?: SprigrCollectionNormalizeOp[] };
  fields_to_compare?: string[];
  report_gaps?: 'incoming_only' | 'existing_only' | 'both';
}

export interface SprigrCollectionsApi {
  define(input: SprigrCollectionDefineInput): Promise<SprigrPlatformBody | null>;
  ingest(input: SprigrCollectionIngestInput): Promise<SprigrPlatformBody | null>;
  ingestFromTable(input: SprigrCollectionIngestFromTableInput): Promise<SprigrPlatformBody | null>;
  query(input: SprigrCollectionQueryInput): Promise<SprigrPlatformBody | null>;
  reconcile(input: SprigrCollectionReconcileInput): Promise<SprigrPlatformBody | null>;
  describe(input: { collection: string }): Promise<SprigrPlatformBody | null>;
  /** `limit` 1..200, default 50. */
  history(input: { collection: string; object_id?: string; field?: string; limit?: number }): Promise<SprigrPlatformBody | null>;
  /** Pass `ids` and/or `keys`; at least one record. */
  delete(input: { collection: string; ids?: string[]; keys?: Record<string, unknown>[] }): Promise<SprigrPlatformBody | null>;
  /** Loop, passing back the returned cursor, until the result says done. */
  clear(input: { collection: string; cursor?: string | null; max_records?: number }): Promise<SprigrPlatformBody | null>;
}

// ---------------------------------------------------------------- fulfillment_services

export interface SprigrFulfillmentServicesApi {
  register(input: { serviceKey: string; serviceName: string } & Record<string, unknown>): Promise<SprigrPlatformBody>;
  list(input?: Record<string, unknown>): Promise<SprigrPlatformBody>;
  /** Always rejects with code not_supported. */
  update(): Promise<never>;
  delete(input: { serviceKey: string } & Record<string, unknown>): Promise<SprigrPlatformBody>;
}

// ---------------------------------------------------------------- ftp

export interface SprigrFtpUploadInput {
  host: string;
  protocol: 'ftp' | 'ftps';
  username: string;
  password: string;
  filename: string;
  /** Non-empty. */
  content_base64: string;
  /** Default 21. */
  port?: number;
  remote_dir?: string;
}

export interface SprigrFtpApi {
  /** Rejects when the platform answers `ok: false`, even on a 2xx. */
  upload(input: SprigrFtpUploadInput): Promise<SprigrPlatformBody & { ok: true; remote_path?: string; bytes?: number }>;
}

// ---------------------------------------------------------------- composed

/** The namespaces above, as they appear on `env.SPRIGR`. Intersect with the other typed APIs your app uses. */
export interface SprigrHostApis {
  usage: SprigrUsageApi;
  acl: SprigrAclApi;
  connect: SprigrConnectApi;
  integrations: SprigrIntegrationsApi;
  run_workflow: SprigrRunWorkflow;
  browser: SprigrBrowserApi;
  schedules: SprigrSchedulesApi;
  store: SprigrStoreApi;
  collections: SprigrCollectionsApi;
  fulfillment_services: SprigrFulfillmentServicesApi;
  ftp: SprigrFtpApi;
}

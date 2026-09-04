/**
 * Typed contract for the `env.SPRIGR` platform host object.
 *
 * This mirrors the runtime wrapper the marketplace injects on the platform
 * (containers/build-runner/.../sprigr-wrapper.ts). It is a REFERENCE type:
 * every method is staging-only (the `sprigr app dev` stub throws), so
 * handlers wrap calls in `stagingOnly()` from env.ts.
 *
 * Errors: most methods throw an Error with `.code` (string) + `.status`
 * (number) on a platform-level failure — e.g. 'no_grant_for_tool',
 * 'no_consent', 'scope_not_granted', 'integration_not_found'. Branch on
 * `err.code`. The exception is `run_workflow`, which never throws: it
 * returns `{ ok: false, ... }` on timeout/error so a decision-point caller
 * can treat that as "use the default".
 */

/**
 * One `env.SPRIGR.log` row. Mirrors `SprigrLogEntry` in @sprigr/apps-app-sdk
 * 0.10.1+; declared locally because this example pins the SDK from npm, the
 * way a real app does, and a pin has to exist before it can be imported.
 */
export interface SprigrLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 1-64 chars of [A-Za-z0-9._:-]; stored as `<slug>.<category>`. */
  category: string;
  /** <= 256 chars. */
  summary: string;
  /** <= 4096 chars. */
  detail?: string;
  /** Plain object, JSON <= 3840 chars. */
  metadata?: Record<string, unknown>;
  agent_id?: string;
  trace_id?: string;
}

export type SprigrLogResult =
  | { ok: true; written: number }
  | { ok: false; error: string; status?: number; detail?: string };

/** A platform error carries a machine-readable code + HTTP status. */
export interface SprigrHostError extends Error {
  code?: string;
  status?: number;
}

export type StoreScope = 'company' | 'publisher';

export interface SprigrHost {
  /** Emit a marketplace event. opts.targetAppInstallationId pins delivery. */
  emit(
    name: string,
    payload: unknown,
    opts?: {
      sourceIntegration?: unknown;
      targetAppInstallationId?: string;
      dedupId?: string;
    },
  ): Promise<unknown>;

  /**
   * Durable app log rows (Analytics Engine `system_logs`, 90 days, scoped to
   * the install's company, category stored as `<slug>.<category>`). Use it
   * instead of a per-webhook / per-tick audit row in D1. Caps (summary 256,
   * detail 4096, metadata JSON 3840, category 64 of [A-Za-z0-9._:-], 50
   * entries per call) THROW synchronously; after that the promise never
   * rejects. Type + inline-route fallback: `SprigrLogFn`, `logToPlatform`
   * in @sprigr/apps-app-sdk.
   */
  log(input: SprigrLogEntry | SprigrLogEntry[]): Promise<SprigrLogResult>;

  usage: {
    /** Report billed token usage for metering. billedTokens rounds to int. */
    report(input: {
      billedTokens: number;
      kind?: string;
      model?: string;
      meta?: unknown;
    }): Promise<unknown>;
  };

  /** Map a provider external account id to this channel install. */
  registerChannel(type: string, externalId: string): Promise<unknown>;

  /** Register a provider tenant id for SHARED webhook fan-out. */
  registerWebhookTenant(tenantId: string, opts?: { path?: string }): Promise<unknown>;

  integrations: {
    /** Invoke a tool on a brand-connected built-in integration (e.g. shopify). */
    invoke(req: {
      type: string;
      integrationId: string;
      tool: string;
      args: Record<string, unknown>;
    }): Promise<unknown>;
  };

  /** Run a tenant workflow (decision-points). Never throws — returns {ok:false} on error. */
  run_workflow(
    workflowId: string,
    opts?: { input?: unknown; timeout_ms?: number },
  ): Promise<{ ok: boolean; output?: unknown; error?: string; detail?: string; timedOut?: boolean }>;

  schedules: {
    /** Create an agent-side schedule at runtime. */
    create(req: {
      name: string;
      cron?: string;
      fireAt?: string;
      prompt?: string;
      agentSlug?: string;
      taskType?: string;
      enabled?: boolean;
      timezone?: string;
    }): Promise<{ scheduleId: string; agentSlug: string; existing: boolean }>;
  };

  browser: {
    /** One-shot headless fetch. Requires the sprigr.browser:fetch scope. */
    fetch(
      url: string,
      opts?: {
        evaluate?: string;
        referer?: string | null;
        humanize?: boolean;
        waitForSelector?: string;
        timeoutMs?: number;
      },
    ): Promise<{ status: number; finalUrl: string; html?: string; evaluateResult?: unknown }>;
    /** One-shot screenshot (base64). */
    screenshot(
      url: string,
      opts?: { fullPage?: boolean },
    ): Promise<{ url: string; screenshot_b64: string }>;
    /** Stateful, cookie-persistent sessions. PUBLISHER-OWNER ONLY. */
    session: {
      open(req?: Record<string, unknown>): Promise<{ sessionId: string; hydrated: boolean; cookieCount: number }>;
      act(req: { sessionId: string; action: string; [k: string]: unknown }): Promise<unknown>;
      snapshot(req: { sessionId: string; kind?: string }): Promise<unknown>;
      cookies(req: { op: string; cookieKey: string; sessionId?: string; cookies?: unknown[] }): Promise<{ ok: boolean; cookieCount: number }>;
      close(req: { sessionId: string }): Promise<{ ok: boolean }>;
    };
  };

  jobs: {
    /** Start a durable job. name must match a manifest jobs[].name. */
    start(req: { name: string; params?: unknown; idempotencyKey?: string }): Promise<{ ok: boolean; existing: boolean; job: unknown }>;
    get(jobId: string): Promise<Record<string, unknown>>;
    signal(jobId: string, payload?: unknown): Promise<unknown>;
    cancel(jobId: string): Promise<unknown>;
    list(opts?: { name?: string; status?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
  };

  store: {
    get(key: string, opts?: { scope?: StoreScope }): Promise<string | null>;
    put(key: string, value: string, opts?: { scope?: StoreScope; ttlSeconds?: number }): Promise<{ ok: boolean }>;
    delete(key: string, opts?: { scope?: StoreScope }): Promise<{ ok: boolean; deleted: boolean }>;
    list(opts?: { scope?: StoreScope; prefix?: string }): Promise<string[]>;
  };

  data: {
    /** Import objects into the app's per-company data index. Each needs objectID. */
    import(objects: Array<Record<string, unknown>>): Promise<{ ok: boolean; indexed: number; index: string }>;
    search(opts?: {
      query?: string;
      filters?: unknown;
      hitsPerPage?: number;
      page?: number;
      semantic?: boolean;
      facets?: string[];
    }): Promise<{ ok: boolean; hits: Array<Record<string, unknown>>; nbHits: number; facetCounts?: unknown }>;
    get(objectID: string): Promise<{ ok: boolean; object: Record<string, unknown> | null; index: string }>;
  };

  collections: {
    define(def: Record<string, unknown>): Promise<{ collection: string }>;
    ingest(args: Record<string, unknown>): Promise<unknown>;
    ingestFromTable(args: Record<string, unknown>): Promise<unknown>;
    query(args: Record<string, unknown>): Promise<unknown>;
    reconcile(args: Record<string, unknown>): Promise<unknown>;
    describe(args: Record<string, unknown>): Promise<unknown>;
    history(args: Record<string, unknown>): Promise<unknown>;
  };

  /** Cross-tenant tool dispatch (consumer -> granting app). */
  invoke(toolName: string, args?: Record<string, unknown>): Promise<unknown>;

  inbox: {
    /** Append external messages into the brand's shared inbox. Requires inbox:write. */
    append(req: {
      channel?: string;
      messages: Array<{
        sourceId: string;
        sourceIndex: number;
        direction: string;
        body: string;
        timestamp: string;
        sourceThreadId?: string;
        sourceIsRead?: boolean;
        tags?: string[];
      }>;
    }): Promise<{ ok: boolean; threadsCreated: number; messagesLinked: number; threadIds: string[] }>;
  };

  fulfillment_services: {
    register(req: {
      platform: string;
      integrationId: string;
      serviceKey: string;
      serviceName: string;
      inventoryManagement?: boolean;
      trackingSupport?: boolean;
      requiresShippingMethod?: boolean;
    }): Promise<{ mfsId: string; shopifyServiceId: string; shopifyLocationId: string; callbackUrl: string; created: boolean }>;
    list(req?: { platform?: string; integrationId?: string }): Promise<{ services: Array<Record<string, unknown>> }>;
    update(req: {
      platform: string;
      integrationId: string;
      serviceKey: string;
      serviceName?: string;
      inventoryManagement?: boolean;
      trackingSupport?: boolean;
      requiresShippingMethod?: boolean;
    }): Promise<{ mfsId: string; serviceName: string; status: string }>;
    delete(req: { platform: string; integrationId: string; serviceKey: string }): Promise<{ deleted: boolean; mfsId: string }>;
  };

  files: {
    /** Stream bytes into the app's R2 prefix (no buffering for ReadableStream). */
    putStream(
      key: string,
      body: ReadableStream | Blob | string,
      opts?: { contentType?: string; length?: number; filename?: string },
    ): Promise<{ ok: boolean; key: string; bytes: number; contentType: string }>;
    /** Mint a time-limited URL for a stored file. Re-mint rather than cache. */
    url(key: string, opts?: { expiresIn?: number }): Promise<{ ok: boolean; url: string; expires_at: string; key: string }>;
  };
}

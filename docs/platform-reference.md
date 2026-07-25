# Sprigr Marketplace App Development

Deep reference for building, publishing, and shipping a marketplace app on the Sprigr platform: manifest schema, runtime bindings, publish pipeline, and the OAuth bouncer. Derived from real integration shakedowns; historical notes referencing Sprigr-internal PR numbers or `sprigr-team` file paths are provenance for the platform team and can be ignored by external publishers.

> Building a new app from scratch? Start with the step-by-step walkthrough in [build-guide.md](build-guide.md); this file is the deep reference it links back into. Path note: this kit's worked example lives under `examples/harvest/`; your own apps go under `apps/<slug>/`.

## TL;DR

- A marketplace app is a **Next.js app** (also Astro or Remix) that runs on the Sprigr platform via Cloudflare **Workers-for-Platforms** (WFP), one isolated script per install.
- The publisher repo (`sprigr-apps`) is a Turborepo monorepo. Each app lives in `apps/<slug>/` with a `sprigr-app.json` manifest, a Next.js source tree, and migrations.
- You publish via `sprigr app publish --dir apps/<slug>` (CLI in `sprigr-team/apps/cli`). The platform compiles the source files into a per-install WFP script in a container build job.
- Per-install state lives in a per-install **D1 database** (`env.DB`) bound at upload time. The manifest declares migrations; the platform runs them after every successful build.
- The publisher ships **secrets** (declared in the manifest) and `env.SPRIGR.*` runtime bindings. After [sprigr-team #851], every install also gets `INSTALL_ID`, `COMPANY_ID`, `APP_SLUG`, `SPRIGR_INSTALL_TOKEN`, `SPRIGR_PLATFORM_BASE` bindings.
- OAuth flows through the **publisher-shared bouncer** at `oauth-bouncer.sprigr.com` (prod) / `staging-oauth-bouncer.sprigr.com` (staging). One redirect URI per environment; the bouncer dispatches the callback back to the correct install via the WFP `DISPATCHER` namespace.

---

## 1. Repo layout

```
sprigr-apps/
├── apps/
│   └── procore/                          # one app per directory
│       ├── sprigr-app.json               # the manifest (source of truth)
│       ├── package.json                  # name, version, dependencies (npm-installable)
│       ├── tsconfig.json
│       ├── migrations/
│       │   └── 0001_init.sql             # per-install D1 migrations
│       └── src/
│           ├── app/                      # Next.js app router
│           │   ├── page.tsx              # SSR settings UI for this install
│           │   ├── layout.tsx
│           │   ├── oauth/start/route.ts  # GET /oauth/start  → builds authorize URL
│           │   ├── oauth/callback/route.ts # legacy direct callback (bouncer is preferred)
│           │   ├── api/internal/_auth.ts # bearer auth helper for cron triggers
│           │   ├── api/internal/refresh/route.ts
│           │   ├── api/internal/full-sync/route.ts
│           │   ├── api/internal/incremental-sync/route.ts
│           │   └── api/webhook/procore/route.ts # third-party webhook receiver
│           ├── handlers/                 # the manifest's `handler` modules
│           │   ├── procore-tool.ts       # the agent tool handler
│           │   ├── refresh-tokens.ts     # scheduled / cron handler
│           │   ├── full-sync.ts
│           │   ├── incremental-sync.ts
│           │   ├── oauth-callback.ts     # dispatched by the bouncer
│           │   └── webhook.ts            # dispatched on /__sprigr/webhook/<tool>
│           └── lib/
│               ├── env.ts                # declare global { interface CloudflareEnv extends ProcoreEnv {} }
│               ├── client.ts             # Procore API client
│               ├── store.ts              # per-install D1 helpers
│               ├── tokens.ts             # OAuth refresh-rotation logic
│               ├── sync.ts               # full-sync engine
│               └── vendor/               # vendored copies of in-repo packages
│                   ├── app-sdk/          # see "SDK" below
│                   └── oauth-utils/
├── packages/                             # workspace packages (NOT shipped to publish)
│   ├── app-sdk/                          # @sprigr/apps-app-sdk — types + crypto + state codec
│   ├── oauth-utils/                      # generic OAuth code-exchange + refresh helpers
│   └── procore-types/                    # generated OpenAPI types (heavy, gitignored at runtime)
├── tools/
│   └── codegen-procore/                  # OpenAPI-to-TS codegen (publisher tool, not shipped)
├── docs/                                 # this file
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

**Starting a new app**: don't hand-copy an existing app - run the scaffolder:

```bash
pnpm create:app my-crm                     # OAuth integration (default)
pnpm create:app my-tool --kind tool --no-oauth
```

It generates the full skeleton above (manifest, configs, env typing, D1 settings/secrets tables, OAuth-through-the-bouncer plumbing, a smoke test), runs the vendor sync, and prints the follow-up checklist. Source: [`tools/create-app.mjs`](../tools/create-app.mjs).

**Critical gotcha**: the marketplace build-runner installs your `package.json` with **npm** in a fresh sandbox (no monorepo context, no `workspace:*` resolution). A `workspace:*` dependency or a direct sibling `packages/*` import breaks at publish. Two consumption mechanisms work:

```ts
// GOOD (preferred) — published npm package, exact-pinned in package.json
import { encodeState } from '@sprigr/apps-app-sdk';   // "@sprigr/apps-app-sdk": "0.1.0"

// GOOD (unpublished packages only) — vendored copy under src/lib/vendor/
import { TimezoneSelect } from '../../lib/vendor/timezone-picker';

// BAD — workspace resolution, breaks in the build-runner sandbox
// "@sprigr/apps-app-sdk": "workspace:*"
```

Pin npm deps to an **exact** version: the build-runner reinstalls on every install build, so a range rolls new helper code into production installs without an app release. Vendoring (below) remains for packages not yet on npm.

**Use the script — don't hand-copy:**

1. In your app's `package.json`, declare which workspace packages you want vendored:
   ```jsonc
   {
     "name": "myapp",
     "sprigrVendor": ["timezone-picker", "app-sdk"]
   }
   ```
2. Run `pnpm sync:vendor` from the repo root. The script mirrors `packages/<pkg>/src/` → `apps/myapp/src/lib/vendor/<pkg>/` for every package listed.
3. Import from the relative path: `import { TimezoneSelect } from "../lib/vendor/timezone-picker"`. The marketplace publish bundles only what's under `apps/myapp/` so the vendored copy ships, the workspace dep doesn't.
4. CI gate: `pnpm sync:vendor:check` exits non-zero if any vendored copy has drifted from its source — wire this into your check workflow so a forgotten re-sync gets caught at PR time.
5. **Changing a shared package fans out to EVERY app that vendors it.** `pnpm sync:vendor` rewrites each app's mirror, the version-bump guard then sees all of those apps as "changed" and demands a manifest bump (and therefore a publish) for every one of them. Before editing `packages/*`, ask whether the change can live in the ONE app that needs it instead: for a type extension, a local intersection type (`type MyState = OAuthState & { extra?: boolean }`) is assignable wherever the base type is accepted and costs zero fan-out (see `Ms365OAuthState` in the microsoft-365 app). Reserve shared-package edits for changes at least two apps genuinely consume, and expect to bump every vendoring app when you make one.

Each vendored directory gets an auto-generated `VENDORED.md` reminding readers that the canonical source lives under `packages/`.

Tooling source: [`tools/sync-vendor.mjs`](../tools/sync-vendor.mjs).

## 2. The manifest — `sprigr-app.json`

Single source of truth. Validated server-side at publish.

```jsonc
{
  "sprigr_app": { "version": "1" },
  "metadata": {
    "name": "Procore",
    "slug": "procore",
    "version": "0.2.8",
    "description": "Connect Procore for project management, RFIs, ...",
    "author": { "name": "Sprigr Company", "email": "platform@sprigr.com" },
    "category": "construction",
    "tags": ["construction", "project-management", "..."]
  },
  "kind": "integration",                     // 'integration' | 'tool' | 'agent'
  "runtime": {
    "entry": "src/app/page.tsx",             // SSR entry — must match the Next.js page
    "tier": "ssr",                           // 'ssr' | 'static' | (no_website)
    "framework": "next"                      // 'next' | 'astro' | 'remix' | 'static'
  },
  "permissions": {
    "scopes": ["tools:register", "sprigr.data:write", "sprigr.knowledge:write"],
    "network_domains": [                     // DECLARATIVE allowlist — NOT a WFP outbound firewall (see §2 gotchas)
      "api.procore.com", "sandbox.procore.com", "login.procore.com",
      "login-sandbox.procore.com"
    ]
  },
  "secrets": [                               // populated per-install via portal/CLI
    {
      "key": "PROCORE_CLIENT_ID",
      "label": "Procore OAuth client_id",
      "type": "secret",                      // ALWAYS "secret", never "string" (validation rejects)
      "required": true,
      "publisher_provides": true,            // optional: publisher seeds one shared value via `sprigr app set-publisher-secrets` instead of each installer pasting their own
      "description": "..."
    }
  ],
  "migrations": [
    {
      "file": "migrations/0001_init.sql",    // path relative to the app dir
      "version": 1,
      "description": "Per-install schema for tokens + sync state + audit"
    }
  ],
  "docs": [
    { "file": "docs/composites.json" }       // AI-facing docs shipped with the app — see §2b
  ],
  "schedules": [
    {
      "name": "hourly_token_refresh",        // free identifier, snake_case; may differ from tool (see gotcha below)
      "cron": "*/45 * * * *",
      "tool": "refresh_procore_tokens",      // must name a tools[] entry that declares a handler
      "scope": "per_install"                 // 'per_install' or 'platform' — "install" alone is rejected
    }
  ],
  "tools": [
    {
      "name": "procore",                     // snake_case; collisions across apps allowed (scoped by app)
      "description": "...",
      "handler": "src/handlers/procore-tool.ts",   // path relative to app dir; built into __sprigr_handlers.js
      "input_schema": { /* JSON Schema for the tool args */ }
    },
    {
      "name": "procore_oauth_callback",       // dispatched by the bouncer
      "handler": "src/handlers/oauth-callback.ts",
      "input_schema": { /* { code, redirectUri, environment } */ }
    }
  ]
}
```

**`tools[].idempotency` (optional) — stop double-billing on a model double-call.** A costly or side-effectful tool (a paid render, a send, a create) should declare content-idempotency so two byte-identical calls in ONE agent round (a model double-call, or at-least-once tool delivery) collapse to a single execution instead of charging twice:

```jsonc
"idempotency": {
  "mode": "content",
  "actionField": "action",                              // dispatcher tools: the input field naming the action
  "actions": ["create_project", "draft", "finalize"]    // only these costly actions; omit both fields for a whole-tool policy
}
```

The dedup key is `(turnId, round, toolName, canonical input)` **without** the tool_use id, so two distinct tool_use blocks with identical input merge — but distinct params/seeds (different input) and a genuine later-turn repeat (different turn) never do. The duplicate returns the first call's result. Opt in only where an identical repeat in one round is never intended; never for a counter/increment-style tool.

**Schema gotchas hit during the procore build:**
- `secrets[].type` must be `"secret"`. We initially used `"string"` — rejected with `Invalid secrets[].type`.
- `schedules[].name` must be snake_case. `refresh-tokens` was rejected; `refresh_tokens` works.
- `schedules[].name` is a free identifier (snake_case) and may differ from `schedules[].tool`. The platform dispatcher resolves the handler by the TOOL name (it POSTs `/__sprigr/schedule/<tool_name>`); the schedule name only labels the fire (it travels in the dispatch body, the `x-sprigr-schedule-name` header, and audit rows as `action=schedule:<schedule_name>`). Publish now validates that `schedules[].tool` references a `tools[]` entry that declares a `handler`; a dangling tool reference, or a tool without a handler, rejects the publish. Failed fires (HTTP 4xx/5xx from the handler) audit as `schedule:<name>:handler_error` and land in the platform's `system_logs`, instead of counting as fired. Rollout note: this behaviour shipped in sprigr-team PR #3093 (platform staging, 2026-07-08). Before that, dispatch went by schedule name and a name/tool mismatch silently 404d every fire (found via the shopify hourly backstop). Until the fix reaches platform prod with the next release, keep `name` equal to `tool` for apps published to prod; matching names work correctly on every dispatcher version.
- `schedules[].scope` must be `"per_install"` or `"platform"`. `"install"` was rejected.
- `runtime.tier` is required for non-agent apps (`"ssr"` for Next.js/Astro/Remix, `"static"` for plain HTML).
- `permissions.network_domains` is a **declarative** allowlist, **not** a runtime outbound firewall. Your per-install WFP script can `fetch()` any host regardless of what you declare — there is **no WFP network enforcement** and no "network error" for undeclared hosts (provisioning only length-checks each entry; the build-runner attaches no outbound/WFP network config). Do **not** treat it as an SSRF sandbox. What it IS used for: (1) the inbound-OAuth SSRF guard validates a *templated* OAuth host (e.g. `https://{shop}/…`) against this list before dispatching the install callback (`workers/provisioning/.../inbound-oauth/schemes.ts`); (2) the agent code-mode sandbox uses it to route an agent's blocked `http.request` to an installed app's namespace instead of prompting for raw outbound access; (3) it documents intent for reviewers. Still declare every host you call (OAuth login hosts included) so those paths and reviewers are correct — just don't rely on it to *block* anything at runtime.
- `tools[].handler` paths are **relative to the app dir**, not the bundle root. The build-runner adapter resolves them when generating `__sprigr_handlers.js`.

## 2b. Shipping AI-facing docs (`docs[]`)

Your app can ship its own documentation so agents discover how to use it by search, instead of you hand-authoring docs into the platform repo. Each `docs[]` entry points to a JSON file (under `docs/`) containing an array of doc objects. At publish, the platform validates them and ingests them into a shared `marketplace_app_docs` search index, **isolated per app by an `app_id` facet**. Agents find them via their normal docs search, scoped to the apps their tenant has installed — so an agent only ever sees your app's docs, and they travel with the app version.

**Why bother:** without this, an agent reasons blind about your tools (it may even distrust a tool it can see, because no docs corroborate it). A good `docs/` set turns "I don't think that's a real action" into "use `create_lead_full` — one call, replaces the 4-call chain."

Manifest entry (just the file path — content lives in the file):
```jsonc
"docs": [ { "file": "docs/composites.json" } ]
```

Doc-object shape (one concept per object, recipe-first; the platform injects `app_id`/`app_slug`/`app_version` and maps `keywords` → `_keywords` at ingest — don't set those yourself):
```jsonc
[
  {
    "objectID": "create-lead-full",          // kebab/snake-case, unique within the app
    "title": "create_lead_full — log a lead in one call",  // <= 80 chars, lead with the noun
    "content": "Log a cold enquiry in one call: finds-or-creates the customer + site…",  // recipe-first
    "category": "reference",                  // 'guide' | 'reference' | 'entity' (default 'reference')
    "keywords": "lead, intake, create_lead_full, one call, prospect"  // 15-30 comma-separated terms
  }
]
```

**Caps + validation** (publish is rejected on violation): ≤ 20 doc files, ≤ 100 objects total, ≤ 4000 chars per `content`; `objectID` must be lowercase kebab/snake and unique across all your docs files; each file must be a JSON array. The CLI checks the declaration shape + that each file exists and parses; the server re-validates the content.

**Lifecycle:** every publish **replaces** your app's docs (upsert new, prune removed), so deleting an object from the file removes it from the index on the next publish. Deleting the app prunes all its docs. Ingestion is best-effort — a search hiccup logs but never fails your publish.

**Authoring guidance:** mirror the platform seed-doc recipe — one concept per object, a one-sentence summary first, the runnable invocation next, then failure modes; keep each under ~400 words and split if longer. Real example: [`apps/simpro/docs/composites.json`](../apps/simpro/docs/composites.json).

> Availability: the ingestion + agent-retrieval pipeline shipped to **staging** (sprigr-team PRs #1742 + #1743) and is verified end-to-end there. It reaches prod when those promote to `main` on sprigr-team. Publishing `docs[]` to prod before then is harmless — the field is simply ignored until the platform side lands.

## 3. The SDK (`@sprigr/apps-app-sdk`)

Vendored under `src/lib/vendor/app-sdk/`. Small, no runtime deps. Provides:

- `encodeState(obj)` / `decodeState(str)` — base64url state codec for OAuth + dispatch routing
- `randomHex(bytes)`, `hmacSha256Hex(key, data)`, `constantTimeEqual(a, b)` — Web Crypto wrappers
- `fetchWithRetry(url, init, options)` — exponential-backoff fetch (Procore's API rate-limits hard)
- `putAppFileStream(env, args)` / `appFileUrl(env, args)` (+ `putAppFile`, `getAppFile`, `listAppFiles`, `deleteAppFile`): durable app-scoped file storage for code running **outside** the injected bridge (e.g. inline route handlers); inside a tool / webhook handler use `env.SPRIGR.files` instead (§4)
- Types: `D1Like`, `WebhookArgs`, `ScheduleArgs`, `EventArgs`, `HandlerFn`, `SprigrDataApi`, `SprigrFilesApi` (type `env.SPRIGR.data` / `env.SPRIGR.files` without re-declaring them)

Plus a companion `@sprigr/apps-oauth-utils` (also vendored) with:
- `exchangeAuthCode(config, code, opts)` / `exchangeAndPersist(config, store, code, opts)` — code → tokens (+ race-safe persistence)
- `getValidAccessToken(config, store)` — cached-or-refresh runtime entry point
- `refreshOAuthToken` / `refreshAndPersist` — race-safe refresh rotation (the same pattern simPRO uses)
- `OAuthError` typed errors (`classifyOAuthError`, machine-readable `reason`)

## 4. The runtime env

After [sprigr-team #836] + [#851], every per-install WFP script gets these bindings stamped at upload time:

| Binding | Type | Source | What for |
|---|---|---|---|
| `DB` | D1 | per-install, allocated on first build | Your per-install state (tokens, sync cursors, audit) |
| `KV` | KV namespace | per-install, allocated on first build | Cache / settings KV (optional, only emitted if used) |
| `IMAGES` | Workers Images binding | platform | Image transforms |
| `INSTALL_ID` | plain_text | `app_installations.id` | OAuth state, webhook URLs, audit row stamping |
| `COMPANY_ID` | plain_text | `app_installations.company_id` | Stamp on outbound requests |
| `APP_SLUG` | plain_text | `marketplace_apps.slug` | Self-identification in logs |
| `SPRIGR_INSTALL_TOKEN` | plain_text | HMAC, signed at upload | Bearer for `env.SPRIGR.emit()` calls back to platform |
| `SPRIGR_PLATFORM_BASE` | plain_text | env-aware URL | `https://api.team.sprigr.com` (prod) or `https://staging-api-team.sprigr.com` |
| Plus every manifest `secrets[]` entry | secret_text | the install's `SECRETS_KV` row | Per-install OAuth keys, webhook signing keys, etc. |

Declare them in your env type so `getCloudflareContext({ async: true }).env` is typed:

```ts
// src/lib/env.ts
import type { D1Like } from './vendor/app-sdk';

export interface ProcoreEnv {
  DB: D1Like;
  PROCORE_CLIENT_ID: string;
  PROCORE_CLIENT_SECRET: string;
  INSTALL_ID?: string;     // populated post-#851
  COMPANY_ID?: string;
  APP_SLUG?: string;
  INTERNAL_TRIGGER_SECRET?: string;
  [key: string]: unknown;  // pacifies CloudflareEnv constraint
}

// GLOBAL AUGMENTATION — required, not optional. Without this,
// getCloudflareContext returns env: CloudflareEnv and every access
// like `env.PROCORE_CLIENT_ID` is a TS error.
declare global {
  interface CloudflareEnv extends ProcoreEnv {}
}
export {};
```

Then in routes / handlers:
```ts
// CORRECT — the type comes from the global augmentation
const { env } = await getCloudflareContext({ async: true });

// WRONG — `getCloudflareContext<T>()`'s generic is for CfProperties,
// not env. Easy to misread the type signature; we got bitten on 9
// call sites and had to fix them in v0.2.6.
const { env } = await getCloudflareContext<ProcoreEnv>();
```

### Never rebuild the dispatch env by spread (`{ ...env }` loses every binding)

On the `/__sprigr/*` dispatch path (tool, schedule, event, and platform-webhook handlers) the wrapper does NOT hand you the raw bindings object. It hands you `Object.create(bindings)` with `SPRIGR` attached as a **non-enumerable own property**: the real bindings (`DB`, secrets, `SPRIGR_INSTALL_TOKEN`, ...) live on the prototype, and `SPRIGR` is invisible to enumeration. Consequences:

- `{ ...env }`, `Object.assign({}, env)`, and `Object.keys(env)` see **nothing**. A spread-rebuilt env has `env.DB === undefined`.
- Plain property access (`env.DB`, `env.SPRIGR`) works fine: the prototype chain and own lookup both resolve.

If you need to overlay something on the env (e.g. a patched `SPRIGR` surface), extend the chain instead of copying:

```ts
const out = Object.create(env) as MyEnv;
Object.defineProperty(out, 'SPRIGR', { value: patched, enumerable: false, configurable: false });
return out;
```

Or use the SDK's `overlaySprigr(env, patched)`, which is exactly this.

This works for both env shapes: the dispatch-path wrapper env AND the plain object inline routes get from `getCloudflareContext`. History: the microsoft-365 app's fallback wrappers used `{ ...env, SPRIGR: {...} }`; on the scheduled path this produced an env whose `DB` was undefined, killing every `ms_index_files` run (and its error-path audit) silently for 24h on staging. Fixed in microsoft-365 v0.14.2 (#758).

### Emitting from an inline route (`env.SPRIGR` is absent there)

Inline Next.js route handlers never get the injected `env.SPRIGR` (see above). An app whose provider webhook lands on an inline route — which is the norm when the provider doesn't HMAC bodies, so the marketplace dispatcher can't verify the delivery — therefore has **no working `env.SPRIGR.emit` on the one path that matters most**.

A receiver that only tries the binding emits nothing at all, silently, while still acking the provider 200. Nothing looks broken: no workflow trigger fires, no subscriber runs, no error surfaces. This has shipped four separate times (shopify #478, procore, starshipit, cin7-core), so use the SDK helper instead of hand-rolling it:

```ts
import { emitMarketplaceEvent } from '@sprigr/apps-app-sdk';

const r = await emitMarketplaceEvent(env, 'acme.job.updated', payload, {
  sourceIntegration: { integrationId: env.INSTALL_ID, integrationType: 'acme' },
});
// r = { emitted, via: 'binding' | 'http' | 'none', eventId?, error? }
await audit(env, 'emit', JSON.stringify(r));
```

It picks the transport for you: the injected binding on `/__sprigr/*` dispatch, the install-token bridge (`POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/emit`) from an inline route. It **never throws**, so the provider ack is never at risk, and it times out after 5s.

Record `via` in your audit row. It is the cheapest way to notice the binding silently disappearing again.

Two failure modes it handles that hand-rolled versions miss:

- A **200 with `{queued: false}`** means the platform accepted the call but the enqueue failed. Treating that as success is how an event disappears without a trace (the shopify silent-drop, 2026-05-28). The helper reports `emitted: false`.
- `sourceIntegration` is **omitted entirely** when you pass `undefined`, because the platform validates the shape strictly and 400s on a partial one.

If your app emits from many places, `withSprigrEmitFallback(env)` repairs `env.SPRIGR.emit` once and leaves existing call sites untouched; it matches the host object's contract (resolves `{ ok, eventId, queued }`, throws on non-2xx).

Both need `SPRIGR_PLATFORM_BASE` + `SPRIGR_INSTALL_TOKEN`, which unlike `SPRIGR` are plain script vars stamped on every per-install upload and so ARE readable from an inline route. When either is missing the helper returns `via: 'none'` and names which one, rather than guessing a default: an app that assumed `https://webhooks.sprigr.com` would have a *staging* install firing events into *prod*.

### `env.SPRIGR`: platform callbacks (no API key)

Tool / event / webhook handlers also get an injected `env.SPRIGR` host object. Every method calls back to the platform over the per-install `SPRIGR_INSTALL_TOKEN` bearer, so your app never holds a Sprigr or platform API key, and the platform scopes every call to the install's own company. The surface:

| Call | What it does |
|---|---|
| `emit(name, payload, opts?)` | Emit a marketplace event (subscribers / cross-tenant fan-out) |
| `collections.{define,ingest,ingestFromTable,query,reconcile,describe,history}` | Typed + faceted data store (see below) |
| `data.{import,search,get,delete,listIds}` | Raw private discovery index (`<companyId>-app-<slug>`) for search-then-fetch-live; `delete`/`listIds` maintain a mirror (see below) |
| `schedules.create(args)` | Self-provision an agent-side scheduled task |
| `integrations.invoke(req)` / `invoke(tool, args)` | Call a built-in integration / cross-tenant tool |
| `run_workflow(id, opts)` | Synchronously run a tenant workflow (Decision Points) |
| `inbox.append(args)` / `registerChannel(...)` / `usage.report(...)` | Inbox mirror, shared-channel routing, usage metering |
| `files.{putStream,url}` | Durable app-scoped file storage in Sprigr R2 + signed download URLs (see below) |
| `jobs.{start,get,signal,cancel,list}` | Durable, resumable multi-step jobs (declare in manifest `jobs[]`; needs `sprigr.jobs`) |
| `store.{get,put,delete,list}` | Company/publisher-scoped KV (needs `sprigr.jobs`; publisher scope needs `sprigr.jobs:publisher`) |
| `browser.fetch(url,opts)` / `browser.screenshot(url,opts)` | One-shot headless fetch/screenshot (needs `sprigr.browser:fetch`) |
| `browser.session.{open,act,snapshot,cookies,close}` | **OWNER-ONLY** stateful, cookie-persistent browser sessions (see below) |

**`browser.session`: stateful browser for a login-walled portal (owner-only).** The one-shot
`browser.fetch` can't drive a multi-step, logged-in portal that has no API. `browser.session`
exposes the pool's real session lifecycle, but ONLY to the app's OWNER install (the publisher
running its own app: `company_id === publisher_company_id`, resolved server-side). Every call
from a non-owner install returns `403 not_publisher_owner`. Requires `sprigr.browser:session`
**and** `sprigr.jobs:publisher` in `permissions.scopes`. Motivating case: the Sprigr Shopify
app's HQ install drives the Shopify Partner/Dev dashboards (no Partner API) from a seeded
logged-in session.

```ts
// open a session (optionally hydrating a persisted cookie jar), drive it, read it, close it.
const s = await env.SPRIGR.browser.session.open({ url: 'https://dev.shopify.com/dashboard', cookieKey: 'shopify-partner', hydrateCookies: true });
const snap = await env.SPRIGR.browser.session.snapshot({ sessionId: s.sessionId, kind: 'snapshot' }); // a11y tree: { tree:[{ref,role,name,...}] }
await env.SPRIGR.browser.session.act({ sessionId: s.sessionId, action: 'click', ref: someRef }); // action: navigate|click|fill|select|hover|scroll|keypress|wait|evaluate
await env.SPRIGR.browser.session.cookies({ op: 'save', sessionId: s.sessionId, cookieKey: 'shopify-partner' }); // persist the jar across runs; op also seed|load
await env.SPRIGR.browser.session.close({ sessionId: s.sessionId });
```

Seed the initial logged-in jar with `cookies({ op: 'seed', cookieKey, cookies })` (write a captured
array directly), or `open()` a session, log in via the returned `viewerUrl`, then `cookies({ op:'save' })`.
The jar + per-session ownership live in a reserved store namespace the app can't read directly.
Best paired with a durable `jobs[]` step function so the run can park on `wait` and resume when an
operator re-seeds an expired jar. `s.viewerUrl` is a live screencast for in-session 2FA.

**Mirror maintenance (`data.delete` + `data.listIds`).** An app that mirrors an external store into its index (e.g. OneDrive file indexing) needs more than upserts. `data.delete(objectIDs, opts?)` removes rows whose source items were deleted (idempotent; unknown IDs are a no-op). `data.listIds(prefix, opts?)` -> `{ objectIDs, total, truncated }` enumerates what the index currently holds under a required prefix, so a full re-walk of the source can diff its live set against the index and delete rows the walk did not see - the only way to heal rows whose one-shot deletion signal (a delta `@removed` entry) was consumed before the app could act on it. Both take `{ withAcl: true }` to target the ACL index (`<companyId>-app-<slug>-acl-files`); unlike `search`/`get` they are permitted there, because a delete only reduces what the index holds and an IDs-only listing carries no row content or principals. Both are `?`-optional on older wrapper builds - feature-detect and degrade (skip the reconcile; never delete on uncertainty). Reference implementation: `apps/microsoft-365/src/lib/file-indexing.ts` (`reconcileWalk`).

**Collections: a typed, faceted, queryable store.** Use it when your connector owns structured records it wants to query, facet, sort, and report on (an OMS board, an order ledger, a parts catalogue). It is the richer sibling of `data.*` (which is a raw discovery index): collections add a declared schema, deterministic dedup keys, optional change history, faceted querying, and cross-source reconcile.

```ts
// 1. Define once (idempotent). ALWAYS returns the full index name in
//    .collection; capture it for ingest/query. Best called from on_install.
const { collection } = await env.SPRIGR.collections.define({
  scope: 'company',
  name_suffix: 'oms-orders',
  description: 'OMS dispatch board snapshot',
  key: { strategy: 'composite', fields: ['cin7_order_no', 'oms_create_time'] },
  fields: [
    { name: 'cin7_order_no', type: 'string', facet: true },
    { name: 'order_status',  type: 'string', facet: true },
    { name: 'client',        type: 'string', facet: true },
  ],
  searchable: ['cin7_order_no', 'client', 'tracking'],
  history: true,
});

// 2. Ingest (upsert by the declared key). Cap 1000 records/call: chunk.
for (let i = 0; i < rows.length; i += 1000) {
  await env.SPRIGR.collections.ingest({ collection, records: rows.slice(i, i + 1000) });
}

// 3. Query: free text + facet filters + facet counts + sort + pagination.
const res = await env.SPRIGR.collections.query({
  collection,
  filters: 'order_status:Dispatched',
  facets: ['client'],
  hits_per_page: 50,
});
```

Type the surface on your env so calls are checked:

```ts
interface SprigrEnv {
  emit(event: string, payload: unknown, opts?: unknown): Promise<{ ok: boolean; eventId?: string }>;
  collections: {
    define(args: Record<string, unknown>): Promise<{ collection: string; created: boolean }>;
    ingest(args: { collection: string; records: Record<string, unknown>[]; merge_policy?: string }): Promise<{ ok: boolean; ingested: number }>;
    ingestFromTable(args: Record<string, unknown>): Promise<{ ok: boolean; ingested: number }>;
    query(args: { collection: string; query?: string; filters?: string; facets?: string[]; sort_by?: string; page?: number; hits_per_page?: number }): Promise<{ hits: Record<string, unknown>[]; nbHits: number; facetCounts: Record<string, Record<string, number>> | null }>;
    describe(args: { collection: string }): Promise<Record<string, unknown>>;
    history(args: { collection: string; object_id?: string; field?: string; limit?: number }): Promise<Record<string, unknown>>;
    reconcile(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}
// add `SPRIGR?: SprigrEnv;` to your env interface.
```

Field / key / filter semantics match the agent-facing collection tools; the deep reference is the platform seed doc `guide-marketplace-collections-datastore` (plus `guide-collections-define` / `guide-collections-query`). **Do you still need D1?** For records you query / facet / report on, no: the collection replaces a hand-rolled table plus its dedup and query code. Keep D1 for operational bookkeeping (run logs, cursors, outbox rows).

> Inline Next.js route handlers (e.g. `app/api/webhook/*/route.ts`) do **not** get the injected `env.SPRIGR`. From there, call `/internal/wfp/collections/<op>` directly with `SPRIGR_INSTALL_TOKEN` + `SPRIGR_PLATFORM_BASE` — the SDK's `resolveInstallBridge` + `installTokenPost` do the auth and error handling, and `emitMarketplaceEvent` is the ready-made version for `emit`.

**Agent roster (`/internal/wfp/agents/list`).** Apps whose connections are per-actor (one OAuth row per user or agent, e.g. microsoft-365 / google-workspace) can fetch the agents applicable to their install to power a "connect for this agent" selector on their landing page. `GET ${SPRIGR_PLATFORM_BASE}/internal/wfp/agents/list` with the `SPRIGR_INSTALL_TOKEN` bearer returns `{ agents: [{ id, name, slug, agent_type }] }` — active agents of the install's company, filtered to the install's `agent_ids` scoping, platform agents excluded. Fail-soft in the page (treat any error as an empty roster) so the app renders fine on environments where the endpoint isn't deployed yet. See `apps/microsoft-365/src/lib/agents.ts` + the "Connect for an agent" form in its `page.tsx` for the reference implementation, including the signed-viewer gating (`lib/viewer.ts`) that keeps the roster off anonymous hits.

**Durable file storage (`env.SPRIGR.files`).** Persist bytes into your install's own R2 namespace and mint signed, time-limited download URLs. Reach for it to **re-host an ephemeral third-party asset that expires**: a provider hands you a render / export URL it deletes after a short retention window, and you want the link your app returns to keep resolving. Stream the bytes into durable storage while the source still exists, then hand back a signed URL to the stored copy.

- **`putStream(key, body, opts?)` -> `{ ok, key, bytes, contentType }`** streams bytes into the store under an app-relative `key`. `body` is any fetch body; a `ReadableStream` (e.g. a source `Response.body`) is piped straight through to R2 without buffering whole in the isolate, so it handles multi-MB blobs. `opts`: `{ contentType?, length?, filename? }`. Forward `length` for streamed bodies (they carry no `Content-Length`) so the platform can enforce the size cap up front; `bytes` comes back `null` when you omit it.
- **`url(key, opts?)` -> `{ ok, url, expires_at, key }`** mints a signed download URL for a stored `key`. `opts.expiresIn` is seconds, clamped server-side (default 24h, min 60s, max ~10y). The URL expires, so re-mint on demand rather than caching it.

**Isolation + caps.** Every `key` is app-relative; the platform confines it server-side to a per-install prefix (`_apps/{installId}/...`), so an app can only ever touch its own files, never another install's or an agent's. A single `putStream` object caps at **200 MB**. Keys with `..` or absolute segments are rejected, not silently rewritten.

Re-host a provider's expiring asset, mirroring Motion's `persistVideo` (`apps/motion/src/handlers/motion-tool.ts`):

```ts
// Best-effort + guarded: a re-host hiccup must never fail the job, so fall
// back to the ephemeral URL on any miss.
async function persistVideo(env, renderId, sourceUrl) {
  const files = env.SPRIGR?.files;
  if (!files?.putStream || !files?.url) return sourceUrl; // bridge not injected yet
  try {
    const resp = await fetch(sourceUrl);                  // fetch while the source still exists
    if (!resp.ok || !resp.body) return sourceUrl;
    const key = `renders/${renderId}.mp4`;
    const len = Number(resp.headers.get('content-length'));
    await files.putStream(key, resp.body, {
      contentType: 'video/mp4',
      length: Number.isFinite(len) ? len : undefined,
      filename: `${renderId}.mp4`,
    });
    const minted = await files.url(key, { expiresIn: 365 * 24 * 60 * 60 });
    return minted?.url || sourceUrl;                       // durable URL the agent keeps
  } catch {
    return sourceUrl;                                      // never fail the job over a re-host
  }
}
```

Type the namespace from the SDK instead of re-declaring it: `import type { SprigrFilesApi } from './vendor/app-sdk'` and add `files?: SprigrFilesApi` to your `env.SPRIGR` interface. From **inline route handlers** (no injected `env.SPRIGR`), use the SDK's standalone `putAppFileStream` / `appFileUrl` helpers, which hit the same `/internal/wfp/file/*` endpoints with `SPRIGR_INSTALL_TOKEN` + `SPRIGR_PLATFORM_BASE`.

**Document engine (`env.SPRIGR.files.edit` / `.create`).** The platform runs the same sandboxed engines the agent document tools use (python-docx / openpyxl for Office, PyMuPDF for PDF), against files in YOUR install's namespace. `edit({ file_key, format: 'docx'|'xlsx'|'pdf'|'xer'|'pmxml'|'mspdi', operations, output_filename?, output_key?, allow_lossy?, skip_validation?, job_token? })` applies a surgical operations list to a stored file and returns `{ ok, out_file_key, operations_applied, failed_operations? }`; `create({ format: 'docx'|'xlsx', spec, properties?, output_filename?, output_key?, job_token? })` builds a NEW docx/xlsx from a content spec and returns `{ ok, out_file_key }` (create is Office-only: a new PDF is a rendering concern, so build a docx and convert). PDF edit ops: `{type:'list_fields'}` (read-only probe, field data comes back in `operations_applied`), `{type:'fill_form', fields, flatten?}`, `{type:'replace_text', find, replace, page?}` (a `replacements: 0` entry lands in `failed_operations`). Typical provider round-trip: download the provider file, `putStream` it, `edit(...)`, then write `out_file_key`'s bytes back to the provider (see `apps/microsoft-365/src/handlers/onedrive-tools.ts`).

**Schedule formats (`xer` / `pmxml` / `mspdi`) are the exception to the cold-start warning below**: Primavera P6 and MS Project XML edits run a pure-TS engine in-worker (no sandbox), so they return inline. Operations use the platform schedule edit vocabulary (`xer_row_patch`, `xer_row_add`, `xer_row_delete`, bulk `xer_row_patch_where`/`xer_row_delete_where`; `pmxml_activity_leaf_set`, `pmxml_*_add`/`_delete`, bulk `pmxml_activity_leaf_set_where`; `mspdi_task_leaf_set`, `mspdi_*_add`/`_delete`, bulk `mspdi_task_leaf_set_where` — see the m365 `onedrive_edit_schedule` tool description for the full list). `operations_applied` entries are `{kind, matched?}` with `matched` counts on the bulk where-clause kinds. The platform refuses to write on referential-integrity violations (predecessor references a missing task, etc.) with a precise issue list; `skip_validation: true` overrides for deliberately incomplete mid-batch writes. XER output is always emitted byte-exact for P6 import (CRLF + ERMHDR header + `%E` terminator) — never hand-serialize XER around the engine. 30 MB cap per file.

**These calls are SLOW when the engine is cold** (a sandbox container boot can take 1-2 minutes), so a tool call driving them can die at the platform dispatch ceiling while the engine finishes server-side. Pass a **`job_token`** (deterministic per logical call: hash the inputs plus a content version like the provider file's cTag, `^[A-Za-z0-9_-]{8,128}$`) and the platform persists the terminal result under it; re-POSTing the SAME token replays the finished result instantly instead of re-running the engine, so an agent retry of the same tool call converges. Error results replay once, then are consumed so a fresh identical attempt re-runs. A re-POST while the first run is still in flight waits on it rather than double-running. `job(jobToken)` (feature-detect: absent on older platform wrappers) reads the record without consuming: `{ status: 'not_found'|'running'|'done'|'error', result? }`; expose it via a read-shaped (`get_`-prefixed) status tool so it gets the longer read dispatch budget. Only write back to your provider AFTER the bridge returns; that ordering is what makes replay safe (no double side effects). Tell your agents in the tool description that a timed-out call should be retried with identical arguments.

## 4b. Platform-routed AI (billed per tenant)

Your app (or an external service it provisions, like the intabot orchestrator on its own Linux box) can call OpenAI through the platform instead of carrying its own key. The platform injects its OpenAI key and bills the token usage to the install's company in `usage_daily` — the same ledger the quota enforcer and cost dashboard read.

Point any OpenAI-compatible client at the passthrough, using the install token as the api key:

```ts
const base = `${env.SPRIGR_PLATFORM_BASE}/internal/wfp/ai/openai/v1`;
const r = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${env.SPRIGR_INSTALL_TOKEN}`, // the api key
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [...] }),
});
```

With the OpenAI SDK (or any tool that reads `OPENAI_BASE_URL` / `OPENAI_API_KEY`), set `base_url` to the prefix and `api_key` to `SPRIGR_INSTALL_TOKEN`.

- **Auth**: the same per-install HMAC token as `env.SPRIGR.emit()`. The platform re-checks `app_installations.status='active'` per call.
- **Billing**: real input/output/cached token counts land under `agent_id = app:{slug}:{company_id}`. Known models price from the platform model table; unknown models bill at a flat $1-wholesale/1M-tokens rate. There is **no model allowlist** — but you also can't pick a model the platform key can't reach.
- **Limits**: non-streaming only (`stream: true` returns 400 — usage can't be metered mid-stream). Endpoints with no `usage` object (e.g. image generation) still count as one API call but bill 0 tokens.
- **The platform key never leaves Cloudflare**; your install token is stripped before the request is forwarded to OpenAI.

Use this instead of a BYO key whenever you want the customer's AI spend on their Sprigr bill rather than your own provider account.

## 5. The build / publish pipeline

### Publish
```bash
# from the app's directory
sprigr app publish --dir .
```

What happens server-side:
1. CLI POSTs `{ manifest, files: {path: content, ...} }` to `https://staging-api-team.sprigr.com/api/v1/data/marketplace/apps/publish`.
2. Provisioning's `handleMarketplaceAppPublish` validates the manifest, upserts a `marketplace_apps` row, creates a new `marketplace_app_versions` row with `source_files` JSON-stringified onto the row.
3. **No build yet** — publish only stages the source. Builds run per-install.

### Install
- A user clicks Install in the portal → `POST /api/data/apps/:slug/install` → provisioning's `handleAppInstall` creates an `app_installations` row → `provisionMarketplaceInstall` creates a `websites` row (slug shape: `<appSlug>-<lastEightOfInstallId>`, e.g. `procore-5oema5wd`) → grants the installer access in `website_users` → enqueues a build job to `BUILD_JOBS_QUEUE`.
- The build-runner container picks up the job, runs `npm install` + `npx opennext build` for Next.js (or framework-equivalent), then uploads the bundle to WFP as `sprigr-tenant-{prod|staging}-<websiteId>-production`.
- Build-runner's `site-resources.ts` allocates the per-install D1 + KV if missing, then attaches all the bindings above.
- After upload, `applyMigrationsForBuild` runs the manifest's `migrations[]` against the per-install D1.

### Upgrade
- After publishing a new version: `POST /api/v1/data/apps/:slug/install/upgrade` (or portal "Upgrade" banner — added in #845).
- Bumps `app_installations.pinned_version_id` to the latest approved version and re-enqueues the build with the same `websiteId`. The new WFP script replaces the old one; the install URL stays the same; per-install D1 + secrets are preserved.

### Direct curl (for shakedown / scripting)
```bash
API_KEY=sk_mcp_...                                          # from ~/.config/sprigr/credentials.json
COMPANY_ID=comp_3vb6tmuvw089x4qpn8cf

# Trigger upgrade
curl -X POST "https://staging-api-team.sprigr.com/api/v1/data/apps/procore/install/upgrade?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json"

# Poll build status
curl "https://staging-api-team.sprigr.com/api/v1/data/apps/installations/$INSTALL_ID?companyId=$COMPANY_ID" \
  -H "Authorization: Bearer $API_KEY" \
  | jq '.installation.build_status'
```

## 6. OAuth — the publisher-shared bouncer pattern

Procore (and most third-party OAuth providers) require a **single registered redirect_uri per dev-app registration**. But every install is a different URL (`procore-5oema5wd.staging-apps.sprigr.com`, `procore-abc12345.staging-apps.sprigr.com`, ...) — you can't register them all.

The Sprigr solution: a **publisher-shared bouncer worker** at one stable URL that decodes OAuth state, looks up the install, and dispatches the callback back to the right per-install WFP script via the `DISPATCHER` namespace.

```
                      register ONCE in the Procore dev app:
                      https://staging-oauth-bouncer.sprigr.com/procore/oauth/callback

  install URL                         Procore                     bouncer (sprigr-team)
  ───────────                         ───────                     ─────────────────────
  /oauth/start  ─builds authorize URL─►
                ◄──user consents───
                                       ─redirect_uri=bouncer─►
                                                                    decodeState(state)
                                                                    → state.installId
                                                                    dispatchToInstall(installId, {
                                                                      path: '/__sprigr/tool/procore_oauth_callback',
                                                                      body: { code, redirectUri, ... }
                                                                    })
                                                                    ──────────────────►
                                                                                         install runs
                                                                                         procore_oauth_callback
                                                                                         (exchanges code,
                                                                                          stores tokens in DB)
                                                                                         ◄──────────────────
                                                                    successPage()
                                                                  ◄──redirect to /─
```

Implementation rules:
- `/oauth/start` puts the `installId` in the state (from `env.INSTALL_ID`, bound by #851), encodes with `encodeState()`, and uses the bouncer URL as `redirect_uri`. The bouncer URL is environment-aware:
  ```ts
  const isStaging = req.url.includes('staging-apps.sprigr.com');
  const defaultBouncer = isStaging
    ? 'https://staging-oauth-bouncer.sprigr.com/procore/oauth/callback'
    : 'https://oauth-bouncer.sprigr.com/procore/oauth/callback';
  const redirectUri = process.env.PROCORE_REDIRECT_URI ?? defaultBouncer;
  ```
- The bouncer dispatches to `/__sprigr/tool/<app-slug-snake-case>_oauth_callback`. Your manifest **must** declare that tool (`procore_oauth_callback` in our case) and point its `handler` at a module that exchanges the code with Procore. The full dispatch body is `{ code, state, redirectUri, environment, installId }` — `state` is the raw encoded state from `/oauth/start`, so the handler can decode it and verify the `csrf` against the `oauth_csrf` value it stashed in D1; report a mismatch as `{ ok: false, error: 'expired_or_unknown_csrf' }` and the bouncer surfaces it as a real error page instead of a false success.
- When exchanging the code, use the **bouncer's** `redirectUri` (passed in the args), not the install's own URL. Procore validates the `redirect_uri` matches what was sent at `/oauth/start`.

Common failure modes:
- **"redirect uri is malformed or doesn't match"** → either you're hitting a stale OAuth state from before you fixed the redirect URI, OR the Procore dev app hasn't been registered with the staging bouncer URL. Solution: refresh, then check the URL in the address bar — `redirect_uri=staging-oauth-bouncer.sprigr.com/...` is correct.
- **`state.installId='unknown'`** → the install was built before #851 and `env.INSTALL_ID` is unbound. Solution: bump app version, trigger `/install/upgrade`.
- **CSRF mismatch on callback** → state's `csrf` isn't matching the install D1's `oauth_csrf` setting. Usually happens when you start two OAuth flows in parallel (each clobbers the other). Fix: just retry from scratch.

## 7. Local dev

The **final shakedown still happens on the platform** — the full marketplace runtime (WFP dispatch, build-runner container, `env.SPRIGR` platform callbacks) only exists on Cloudflare infra, and `pnpm dev` in `apps/<slug>/` runs Next.js locally with no `env.DB` or platform bindings. But since CLI 0.2.0, handlers and the OAuth callback run locally first:

### `sprigr app dev` — exercise handlers + OAuth callback before first publish

`sprigr app dev --dir apps/<slug>` (Node >= 22.5) runs a local harness emulating the two platform pieces your backend touches:

- **Tool dispatch**: `POST http://localhost:8666/__sprigr/tool/<name>` with a JSON body invokes your handler with the platform's `{ ok: true, result }` envelope. Handlers get a real env: `DB` (per-install D1 backed by a local SQLite file under `.sprigr/dev/`, manifest migrations applied with the platform's ledger semantics), `INSTALL_ID`/`COMPANY_ID`/`APP_SLUG`, and your `secrets[]` values from `--secrets-file` → `.sprigr/dev/secrets.json` → the environment. `env.SPRIGR` throws with a pointer to the platform.
- **Bouncer emulation (§6)**: `GET http://localhost:8666/<slug>/oauth/callback?code&state` decodes the state and dispatches `{ code, state, redirectUri, environment, installId }` to your `<slug>_oauth_callback` tool, with the real bouncer's success/failure rendering (including the inner `ok:false` check). Register the localhost callback URL on your provider's **dev** OAuth app and set `<PREFIX>_REDIRECT_URI` to it; the whole consent → csrf-verify → token-exchange → D1-persist loop then runs on your machine. `GET /dev/state?csrf=...` mints a wire-correct state blob.
- **Local D1 seeding**: `POST /dev/sql` with `{ "sql": "...", "params": [...] }` runs a statement against the local per-install D1 — the harness doesn't serve your Next.js routes, so seed the `oauth_csrf` row your `/oauth/start` would write this way before driving the callback's success path (full recipe: build-guide step 6). Dev-only; no platform equivalent.

Handlers are re-bundled per request, so edits apply without a restart. The scaffolder gitignores `.sprigr/` and pins `esbuild` as a devDependency (the harness bundles handlers with it); apps scaffolded earlier need both added by hand.

### Platform workflow
1. Edit + typecheck locally (`pnpm typecheck`); exercise handlers + OAuth with `sprigr app dev`.
2. `sprigr app publish --dir apps/<slug>` (or via the platform MCP `publish_version`).
3. `sprigr app bouncer-status <slug>` — self-serve check that the slug is live on the shared bouncer (registered + enabled + `<slug>_oauth_callback` declared) and prints the exact callback URL to register with the provider. Exit code gates CI.
4. `POST /install/upgrade` to bump existing installs.
5. Verify on `https://<slug>-<id>.staging-apps.sprigr.com/`.

## 8. CLI / API auth

The `sprigr` binary ships as [`@sprigr/cli` on npm](https://www.npmjs.com/package/@sprigr/cli). Node >= 20 (>= 22.5 for `sprigr app dev`).

```bash
npm install -g @sprigr/cli    # or one-off: npx @sprigr/cli <command>
sprigr login                  # browser flow
sprigr --help                 # full command list
```

`sprigr app dev` and `sprigr app bouncer-status` need CLI >= 0.2.0 (`npm install -g @sprigr/cli@latest` to upgrade). Command map: `login` / `logout` / `whoami` (auth), `app validate|dev|publish|bouncer-status|upgrade|install|share|set-publisher-secrets|delete` (marketplace apps), `deploy` / `pull` / `builds list|get` (tenant sites). CLI credentials live at `~/.config/sprigr/credentials.json`:
```json
{
  "apiKey": "sk_mcp_...",
  "keyPrefix": "sk_mcp_xxxx",
  "keyId": "mkey_...",
  "companyId": "comp_...",
  "userId": "user_...",
  "endpoint": "https://staging-api-team.sprigr.com",
  "loggedInAt": "2026-05-11T23:07:13Z"
}
```

API endpoints:
- All publisher / install API: `${endpoint}/api/v1/data/...` (gateway strips `/api/v1` and forwards to provisioning)
- Auth: `Authorization: Bearer <apiKey>` + optional `x-company-id` (defaults to credentials.companyId)

## 9. Surface checklist for a new app

Minimum viable marketplace app:
- [ ] `apps/<slug>/sprigr-app.json` — manifest with `kind: integration`, `runtime.tier: ssr`, `runtime.framework: next`
- [ ] `apps/<slug>/package.json` — npm-installable, NO `workspace:*` deps
- [ ] `apps/<slug>/migrations/0001_init.sql` — per-install schema
- [ ] `apps/<slug>/docs/*.json` + `docs[]` in the manifest — AI-facing docs so agents discover your tools by search (see §2b)
- [ ] `apps/<slug>/src/lib/env.ts` — `declare global { interface CloudflareEnv extends YourEnv {} }`
- [ ] `apps/<slug>/src/lib/vendor/app-sdk/` — vendored copy of `packages/app-sdk/src/*`
- [ ] `apps/<slug>/src/app/page.tsx` — settings UI (data-bound via `getCloudflareContext({ async: true })`)
- [ ] `apps/<slug>/src/app/oauth/start/route.ts` — if you have OAuth (env-aware bouncer URL!)
- [ ] `apps/<slug>/src/handlers/oauth-callback.ts` — dispatched by the bouncer (file name is free; only the manifest `tools[].name` — `<slug>_oauth_callback` — matters)
- [ ] `apps/<slug>/src/handlers/<tool>.ts` — one per `tools[]` entry
- [ ] `apps/<slug>/src/app/api/internal/_auth.ts` — bearer for internal trigger routes; only needed if you expose `api/internal/*` routes (apps whose schedules only use `schedules[]` tool dispatch don't need it)
- [ ] Try-catch in your settings `page.tsx` `loadState()` — the per-install DB might not have migrations applied yet on a cold install

Test plan:
1. `sprigr app validate --dir apps/<slug>` — manifest schema gate.
2. `sprigr app publish --dir apps/<slug>` — first publish creates `marketplace_apps` row.
3. Install via the portal Marketplace tab. Confirm the install URL renders the diagnostic UI.
4. Confirm `/api/ping` returns 200 (proves WFP + Next.js runtime are healthy).
5. If OAuth: click Connect, follow the redirect, log into the third-party sandbox, confirm `state.installId` decodes to your install id (not `unknown`).
6. Confirm tokens land in your per-install D1's `<slug>_secrets` table.
7. Trigger sync handler via `POST /api/internal/full-sync` with the `INTERNAL_TRIGGER_SECRET` bearer. Confirm rows show up in the audit table.

## 10. References

| What | Where |
|---|---|
| Provisioning marketplace routes | `sprigr-team/workers/provisioning/src/marketplace-routes.ts` |
| Install version-upgrade endpoint | `POST /api/data/apps/:slug/install/upgrade` (added in #838) |
| Build-runner site-resources (binding stamping) | `sprigr-team/workers/build-runner/src/site-resources.ts` |
| Build-runner adapters | `sprigr-team/containers/build-runner/entrypoint/adapters/{next-opennext,astro,remix,static}.ts` |
| Sprigr-path wrapper template | `sprigr-team/containers/build-runner/entrypoint/adapters/sprigr-wrapper.ts` |
| OAuth bouncer | `sprigr-team/workers/marketplace-oauth-bouncer/` |
| dispatchToInstall helper | `sprigr-team/packages/shared/src/utils/dispatch.ts` |
| CLI | `sprigr-team/apps/cli/src/commands/app.ts` |
| Portal install settings page | `sprigr-team/apps/portal/src/app/dashboard/apps/installed/[installId]/page.tsx` |

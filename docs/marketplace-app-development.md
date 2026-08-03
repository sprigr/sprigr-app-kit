# Sprigr Marketplace App Development

End-to-end guide for building, publishing, and shipping a marketplace app on the Sprigr platform. This is the conceptual companion to the hands-on [build-guide](build-guide.md): the build-guide walks you through one app step by step, this page explains the platform surface each step touches (manifest, runtime bindings, publish pipeline, OAuth bouncer, durable jobs).

## TL;DR

- A marketplace app is a **Next.js app** (Astro and Remix also work) that runs on the Sprigr platform via Cloudflare **Workers-for-Platforms** (WFP), one isolated script per install.
- You build apps in **this kit** (`sprigr-app-kit`): scaffold with `pnpm create:app <slug>`, and each app lives in `apps/<slug>/` with a `sprigr-app.json` manifest, a Next.js source tree, and migrations.
- You publish via `sprigr app publish --dir apps/<slug>` (the `@sprigr/cli` package on npm). The platform compiles the source files into a per-install WFP script in a container build job.
- Per-install state lives in a per-install **D1 database** (`env.DB`) bound at upload time. The manifest declares migrations; the platform runs them after every successful build.
- Every install gets its manifest **secrets** plus a set of runtime bindings stamped at upload time (`INSTALL_ID`, `COMPANY_ID`, `APP_SLUG`, an install token, the platform base URL) and the `env.SPRIGR.*` runtime object.
- OAuth flows through the **shared bouncer** at `oauth-bouncer.sprigr.com`. One redirect URI per environment; the bouncer dispatches the callback back to the correct install via the WFP dispatcher namespace.

---

## 1. Repo layout

The kit is a Turborepo monorepo. Your app is one directory under `apps/`:

```
sprigr-app-kit/
├── apps/
│   └── my-crm/                            # one app per directory (pnpm create:app my-crm)
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
│           │   └── api/internal/...      # internal routes (cron triggers, etc.)
│           ├── handlers/                 # the manifest's `handler` modules
│           │   ├── my-crm-tool.ts        # the agent tool handler
│           │   ├── oauth-callback.ts     # dispatched by the bouncer
│           │   └── webhook.ts            # dispatched on /__sprigr/webhook/<tool>
│           └── lib/
│               ├── env.ts                # declare global { interface CloudflareEnv extends MyEnv {} }
│               ├── client.ts             # provider API client
│               ├── store.ts              # per-install D1 helpers
│               └── oauth.ts              # OAuth glue
├── packages/                             # shared packages - published to npm as @sprigr/apps-*
│   ├── app-sdk/                          # types + crypto + state codec
│   ├── oauth-utils/                      # generic OAuth code-exchange + refresh helpers
│   ├── d1-kv/                            # D1-backed token / settings stores
│   └── ...                               # sync-cursor, dedup-latch, webhook-registry, faceted-search
├── tools/                                # scaffolder + sync-vendor + version/migration guards
├── examples/                             # reference apps (harvest, showcase, static-badge, ...)
├── docs/                                 # this file + the rest of the kit docs
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

### How shared code reaches your app: exact-pinned npm packages (preferred), vendoring (fallback)

The marketplace build-runner installs your `package.json` with **npm** in a fresh sandbox - no monorepo context, no `workspace:*` resolution. So you **cannot** `workspace:*`-import from sibling `packages/*`:

```ts
// BAD - works locally with pnpm workspace, breaks on publish
import { encodeState } from '@sprigr/apps-app-sdk';   // via workspace:*
```

There are two supported ways to get shared code into a published app:

**1. Depend on the published npm packages (preferred, and what you want).** Every kit package publishes to npm as `@sprigr/apps-*`, so `npm install` in the build sandbox resolves them cleanly. The scaffolder wires these in for you. **Pin them exactly** (`"@sprigr/apps-oauth-utils": "0.1.0"`, no caret): the build-runner reinstalls on every install build, and a version range would roll new helper code into production installs with no app change and no review. Upgrading a helper is a deliberate app release: bump the pin, bump the app version, publish. See [publishing.md](publishing.md) for the full rationale.

**2. Vendor the source (fallback, for a package that is not on npm).** No package in `packages/` is in that position today, so you should not need this. It stays documented because a future package might not be publishable, and because apps that predate a package's first publish still carry a mirror. The mechanism: declare which packages you want in your app's `package.json`, then run the sync script to copy their source into `src/lib/vendor/`.

```jsonc
{
  "name": "my-crm",
  "sprigrVendor": ["timezone-picker"]
}
```

```bash
pnpm sync:vendor            # mirror packages/<pkg>/src → apps/<app>/src/lib/vendor/<pkg>
pnpm sync:vendor --check    # exit 1 if any vendored copy has drifted (wire into CI)
```

Import from the relative path: `import { TimezoneSelect } from "../lib/vendor/timezone-picker"`. The publish bundles only what's under `apps/<app>/`, so the vendored copy ships and the workspace dependency does not. Each vendored directory gets an auto-generated `VENDORED.md` reminding readers the canonical source lives under `packages/`.

**Do not mix the two mechanisms in one app** - either depend on the npm package or vendor it, never both. Tooling source: [`tools/sync-vendor.mjs`](../tools/sync-vendor.mjs). Both the vendor-drift and migration-immutability guards run under `pnpm verify:local`.

## 2. The manifest - `sprigr-app.json`

Single source of truth. Validated server-side at publish.

```jsonc
{
  "sprigr_app": { "version": "1" },
  "metadata": {
    "name": "My CRM",
    "slug": "my-crm",
    "version": "0.1.0",
    "description": "Connect My CRM for contact sync, deals, ...",
    "author": { "name": "Your Company", "email": "you@example.com" },
    "category": "crm",
    "tags": ["crm", "contacts", "..."]
  },
  "kind": "integration",                     // 'integration' | 'tool' | 'agent'
  "runtime": {
    "entry": "src/app/page.tsx",             // SSR entry - must match the Next.js page
    "tier": "ssr",                           // 'ssr' | 'static'
    "framework": "next"                      // 'next' | 'astro' | 'remix' | 'static'
  },
  "permissions": {
    "scopes": ["tools:register", "sprigr.data:write", "sprigr.knowledge:write"],
    "network_domains": [                     // outbound fetch allowlist enforced by WFP
      "api.example.com", "login.example.com"
    ]
  },
  "secrets": [                               // populated per-install via portal/CLI
    {
      "key": "PROVIDER_CLIENT_ID",
      "label": "Provider OAuth client_id",
      "type": "secret",                      // ALWAYS "secret", never "string" (validation rejects)
      "required": true,
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
    { "file": "docs/composites.json" }       // AI-facing docs shipped with the app - see §2b
  ],
  "schedules": [
    {
      "name": "refresh_tokens",              // snake_case, kebab is rejected
      "cron": "*/45 * * * *",
      "tool": "refresh_provider_tokens",     // must match a tools[].name
      "scope": "per_install"                 // 'per_install' or 'platform' - "install" alone is rejected
    }
  ],
  "tools": [
    {
      "name": "my_crm",                      // snake_case; collisions across apps allowed (scoped by app)
      "description": "...",
      "handler": "src/handlers/my-crm-tool.ts",   // path relative to app dir; built into __sprigr_handlers.js
      "input_schema": { /* JSON Schema for the tool args */ }
    },
    {
      "name": "my_crm_oauth_callback",        // dispatched by the bouncer
      "handler": "src/handlers/oauth-callback.ts",
      "input_schema": { /* { code, redirectUri, environment } */ }
    }
  ]
}
```

**Common schema gotchas:**
- `secrets[].type` must be `"secret"`. `"string"` is rejected with `Invalid secrets[].type`.
- `schedules[].name` must be snake_case. `refresh-tokens` is rejected; `refresh_tokens` works.
- `schedules[].scope` must be `"per_install"` or `"platform"`. `"install"` alone is rejected.
- `runtime.tier` is required for non-agent apps (`"ssr"` for Next.js/Astro/Remix, `"static"` for plain HTML).
- `permissions.network_domains` is an outbound allowlist - every domain `fetch()` calls **must** be there, including OAuth login hosts. WFP returns a network error otherwise.
- `tools[].handler` paths are **relative to the app dir**, not the bundle root. The build-runner adapter resolves them when generating `__sprigr_handlers.js`.

## 2b. Shipping AI-facing docs (`docs[]`)

Your app can ship its own documentation so agents discover how to use it by search, instead of you hand-authoring docs into a platform repo. Each `docs[]` entry points to a JSON file (under `docs/`) containing an array of doc objects. At publish, the platform validates them and ingests them into a shared app-docs search index, **isolated per app by an `app_id` facet**. Agents find them via their normal docs search, scoped to the apps their tenant has installed - so an agent only ever sees your app's docs, and they travel with the app version.

**Why bother:** without this, an agent reasons blind about your tools (it may even distrust a tool it can see, because no docs corroborate it). A good `docs/` set turns "I don't think that's a real action" into "use `create_lead_full` - one call, replaces the 4-call chain."

Manifest entry (just the file path - content lives in the file):
```jsonc
"docs": [ { "file": "docs/composites.json" } ]
```

Doc-object shape (one concept per object, recipe-first; the platform injects `app_id`/`app_slug`/`app_version` and maps `keywords` → `_keywords` at ingest - don't set those yourself):
```jsonc
[
  {
    "objectID": "create-lead-full",          // kebab/snake-case, unique within the app
    "title": "create_lead_full - log a lead in one call",  // <= 80 chars, lead with the noun
    "content": "Log a cold enquiry in one call: finds-or-creates the customer + site…",  // recipe-first
    "category": "reference",                  // 'guide' | 'reference' | 'entity' (default 'reference')
    "keywords": "lead, intake, create_lead_full, one call, prospect"  // 15-30 comma-separated terms
  }
]
```

**Caps + validation** (publish is rejected on violation): ≤ 20 doc files, ≤ 100 objects total, ≤ 4000 chars per `content`; `objectID` must be lowercase kebab/snake and unique across all your docs files; each file must be a JSON array. The CLI checks the declaration shape + that each file exists and parses; the server re-validates the content.

**Lifecycle:** every publish **replaces** your app's docs (upsert new, prune removed), so deleting an object from the file removes it from the index on the next publish. Deleting the app prunes all its docs. Ingestion is best-effort - a search hiccup logs but never fails your publish.

**Authoring guidance:** one concept per object, a one-sentence summary first, the runnable invocation next, then failure modes; keep each under ~400 words and split if longer.

## 2c. Durable jobs + the scoped store

For work that outlives a single request - a multi-minute sync, a browser-automation flow, anything that has to sleep, retry, or pause for a human - the platform gives you **durable jobs**. You declare a job in the manifest and implement it as a **step function**: a regular `tools[]` entry the platform dispatches once per step through the existing `/__sprigr/tool/<tool>` path. The platform owns durability (the run survives restarts), per-step retries, durable sleep, waiting for an external signal, state persistence, status queries, and lifecycle events. You own the step logic. Because it rides the tool-dispatch path, a job works against an already-deployed bundle the moment the manifest declares it - no new handler wiring.

A companion **scoped store** (`env.SPRIGR.store`) gives jobs state that outlives one run and, optionally, is shared across every install of your app (the motivating case: a login/cookie session an ops job maintains and every install reuses - per-install D1 can't express cross-install state).

### Manifest: declare the job and the scope

```jsonc
{
  "permissions": {
    "scopes": ["tools:register", "sprigr.jobs"]   // 'sprigr.jobs' is REQUIRED for jobs + store
  },
  "tools": [
    {
      "name": "provision_step",                    // the STEP FUNCTION - a normal tool
      "description": "One step of the provisioning job",
      "handler": "src/handlers/provision.ts",
      "input_schema": { /* receives { job: {...} } - see below */ }
    }
  ],
  "jobs": [
    {
      "name": "provision_partner_app",             // lowercase snake_case, unique within the app
      "tool": "provision_step",                    // MUST name a tools[] entry (its step function)
      "description": "Provision a partner dashboard app end-to-end",
      "timeout_minutes": 120,                       // whole-job wall clock. default 60, max 10080 (7d)
      "step_timeout_seconds": 90,                   // per-step dispatch wall. default 60, range 5..270
      "max_steps": 100,                             // runaway guard. default 200, max 450
      "retries": {                                  // per-STEP retry policy
        "limit": 5,                                 // attempts after the first failure. default 3, max 10
        "delay_seconds": 10,                        // base delay. default 10, max 3600
        "backoff": "exponential"                    // 'constant' | 'linear' | 'exponential' (default)
      }
    }
  ]
}
```

**Manifest gotchas (publish is rejected on violation - `validateJobs` runs inside `validateManifest`):**
- `jobs[].name` must be lowercase snake_case and unique within the app; ≤ 20 jobs per manifest.
- `jobs[].tool` must reference a declared `tools[]` entry. A job pointing at a missing tool is a publish-time error.
- All numeric fields are range-clamped to the caps above; an out-of-range value is rejected.
- `permissions.scopes` must include `"sprigr.jobs"`. The tenant consents to "this app runs long background work" at install time; the scope is checked against the install's `granted_scopes` on every runtime call, so revoking it stops new runs without a redeploy.

### The step-function contract

Every dispatch, your step-function tool receives `args.job` and returns a **directive**.

```ts
// src/handlers/provision.ts
export default async function provisionStep(args) {
  const { id, name, step, attempt, params, state, signal } = args.job;
  // step:    monotonic 0-based counter
  // attempt: 1-based dispatch attempt of THIS step (resets when the step advances)
  // params:  immutable, supplied at jobs.start
  // state:   whatever the previous step's directive persisted (null on step 0)
  // signal:  present ONLY on the dispatch right after a `wait` -   //          { delivered: true, payload } if jobs.signal resumed it,
  //          { delivered: false } if the wait timed out

  if (step === 0) {
    const session = await ensureLogin();                       // do one increment of work
    return { op: 'continue', state: { session }, label: 'logged in' };
  }
  // ...
  return { op: 'complete', result: { appId } };
}
```

The directive union:

| directive | effect |
|---|---|
| `{ op: 'continue', state?, label? }` | persist `state`, dispatch the next step immediately (omit `state` to carry the previous state forward) |
| `{ op: 'sleep', seconds, state?, label? }` | persist `state`, sleep durably (`seconds` 1..86400), then dispatch the next step |
| `{ op: 'wait', reason?, timeout_seconds?, state?, label? }` | park the run until `jobs.signal(jobId, payload)` arrives OR `timeout_seconds` elapses (default 86400, max 604800). The next step's `job.signal` says which happened. This is the human-in-the-loop / external-event primitive (OTP entered, approval arrived, webhook fired) |
| `{ op: 'complete', result? }` | terminal success; `result` is stored and returned by `jobs.get` |
| `{ op: 'fail', error?, retryable? }` | terminal failure. With `retryable: true` the **step** is retried per the policy instead (equivalent to throwing) |

A thrown error or a non-2xx response **retries the step** per the declared `retries` policy; when retries exhaust, the job fails.

> **At-least-once, so make each step idempotent.** The platform may re-dispatch a step whose response was lost after the work already happened. Key any external side effect on `job.step` (plus a dedupe key), or make the effect naturally idempotent. A step whose response is already persisted is reconstructed from the row without re-dispatching, but a step that ran and never returned WILL run again.

`label` on any non-terminal directive is surfaced by `jobs.get`/`jobs.list` as progress (≤ 256 chars). Payload caps: `params` ≤ 32KB, `state` and `result` ≤ 128KB, `error` ≤ 8KB - a step whose `state`/`result` exceeds the cap fails the job.

**Config is snapshot at start.** The job's timeouts, `max_steps`, and retry policy are stamped onto the run when it starts, so a version upgrade mid-flight can't change an in-flight run's behavior.

### App-side API - `env.SPRIGR.jobs`

Call these from any route or handler (all calls carry the per-install bearer and the `sprigr.jobs` scope):

```ts
const { env } = await getCloudflareContext({ async: true });

// Start a run. name MUST match a manifest jobs[].name.
const { ok, existing, job } = await env.SPRIGR.jobs.start({
  name: 'provision_partner_app',
  params: { partnerEmail },
  idempotencyKey: `provision:${partnerEmail}`,   // optional - see below
});

await env.SPRIGR.jobs.get(job.job_id);           // full record { job_id, name, status, label,
                                                 //   waiting_reason, step_count, params, state,
                                                 //   result, error, ... }
await env.SPRIGR.jobs.list({ name, status, limit });   // lean records; limit capped at 50
await env.SPRIGR.jobs.signal(jobId, payload);    // resume a run parked by a `wait` (no-op-safe if not waiting)
await env.SPRIGR.jobs.cancel(jobId);             // cancel the run
```

Statuses: `queued | running | sleeping | waiting | completed | failed | cancelled`.

- **Idempotent starts.** Pass `idempotencyKey` (non-empty string, ≤ 256 chars) and a re-start with the same key returns the existing run with `existing: true` - no duplicate. Race-safe: a concurrent start with the same key still resolves to the one run.
- **Concurrency cap.** An install may have at most **10 active** (non-terminal) runs. Start #11 returns `too_many_active_jobs` (429) until one finishes or is cancelled.
- **Cancel semantics.** `queued`/`sleeping`/`waiting` runs finalize immediately. A `running` step is **never killed mid-flight** - the cancel flag lands at the next step boundary (every step re-reads the row, so cancels and uninstall CASCADEs are honored there).

### Lifecycle events - subscribe instead of polling

Terminal transitions emit marketplace events **pinned to the owning install**, so you can react without polling `jobs.get`:

- `sprigr.job.started` - on start
- `sprigr.job.completed` / `sprigr.job.failed` / `sprigr.job.cancelled` - on the terminal transition

Subscribe via `events.subscribes[]` (self-subscription is allowed - the event your own app emitted routes back to a tool you name):

```jsonc
"events": {
  "subscribes": [
    { "event": "sprigr.job.completed", "handler_tool": "on_job_done" }
  ]
}
```

Finalization is transition-guarded, so each terminal event fires exactly once (no double delivery on retry/replay).

### The scoped store - `env.SPRIGR.store`

A small key/value store for state that outlives a single run. Values are strings (`JSON.stringify` objects yourself), ≤ **128KB**, with an optional TTL.

```ts
await env.SPRIGR.store.put('cookie-jar', JSON.stringify(jar), { ttlSeconds: 3600 });
const raw = await env.SPRIGR.store.get('cookie-jar');          // string or null
await env.SPRIGR.store.delete('cookie-jar');
const keys = await env.SPRIGR.store.list({ prefix: 'session:' });
```

Two scopes, selected via `opts.scope`:

- **`company`** (default) - namespaced to `(app, company)`. Always safe; matches the per-install model. Needs only the base `sprigr.jobs` scope.
- **`publisher`** (sensitive) - namespaced to `(app, publisher_company_id)`, **shared across every install of your app**. This is how a durable job shares one login/cookie session across all installs. It is double-gated:
  1. the install must have the stricter **`sprigr.jobs:publisher`** scope in `permissions.scopes` (in addition to the base `sprigr.jobs`);
  2. the namespace owner id is resolved **server-side** from the install → app → publisher - never taken from the caller. A caller that lies about scope or ids cannot cross the boundary.

```jsonc
// to use publisher scope, declare BOTH:
"permissions": { "scopes": ["tools:register", "sprigr.jobs", "sprigr.jobs:publisher"] }
```

```ts
// then pass the scope explicitly:
await env.SPRIGR.store.put('publisher-session', blob, { scope: 'publisher' });
const shared = await env.SPRIGR.store.get('publisher-session', { scope: 'publisher' });
```

A `publisher`-scoped call without the `sprigr.jobs:publisher` grant returns `publisher_scope_not_granted` (403).

## 2d. App cards (interactive chat cards)

A tool response may include a reserved top-level **`_artifacts`** array. Entries shaped `{ type: 'panel', panelKind: 'app_card', title, panelData }` render as **native interactive cards** in the portal chat: images, labeled fields, a table, and action buttons that execute your tools directly. Cards are **stripped from what the LLM sees**, so your JSON response must still be the complete answer on its own - the card is a presentation layer for the human, not a channel to the agent.

```ts
// a tool handler: return your normal response, plus the card
const response = { ok: true, order };            // what the agent reads
return {
  ...response,
  _artifacts: [{
    type: 'panel',
    panelKind: 'app_card',
    title: `Order ${order.number}`,
    panelData: {
      card_id: `order-${order.id}`,              // STABLE per subject - reuse on re-render
      title: `Order ${order.number}`,
      subtitle: order.customer_name,
      images: [{ url: order.photo_url, alt: 'Product photo' }],   // https:// only
      fields: [
        { label: 'Status', value: order.status, tone: 'warning' }, // 'default' | 'success' | 'warning' | 'danger'
        { label: 'Total', value: `$${order.total}`, badge: 'net' },
      ],
      table: { columns: ['SKU', 'Qty'], rows: order.lines.map(l => [l.sku, String(l.qty)]) },
      actions: [{
        id: 'approve',
        label: 'Approve',
        variant: 'primary',                      // 'primary' | 'secondary' | 'danger'
        tool: 'orders',                          // must name one of YOUR tools[] entries
        args: { action: 'approve', order_id: order.id },
        confirm: 'Approve this order?',          // renders a two-click confirmation
        disable_after: 'all',                    // 'this' | 'all' - which buttons disable on success
      }],
      state: 'active',                           // 'active' | 'completed' | 'failed'
      footer: `myapp · order ${order.id}`,
    },
  }],
};
```

`card_id` and `title` are required; `subtitle`, `images` (`[{url, alt?}]`), `fields`, `table`, `actions`, `state`, `state_note` (short status line shown with the state), and `footer` are optional. Unknown keys are stripped.

**Caps** (enforced platform-side; a violating entry is dropped, never partially rendered):

| Cap | Limit |
|---|---|
| Cards per tool result | 3 |
| Serialized `panelData` | 32KB |
| Images | 12, `https://` URLs only |
| Actions | 6 |
| Markup | none, ever - see below |

**Security model.** Three properties you can rely on, and must not fight:

- **The platform stamps identity.** `panelData.install_id` and `app_slug` are set by the platform bridge from the invocation context. Omit them - supplied values are discarded. A card cannot claim to be from another app or install.
- **Data-only: no markup ever renders.** Any string anywhere in the card (including nested `args` values) containing `<` followed by a letter drops the whole entry. Sanitize free text before it goes in - strip tag-like sequences rather than trying to escape them.
- **Actions execute directly.** Clicking a button invokes the named tool with the given `args` against the emitting install, authenticated as the **clicking user's session**. No agent turn runs; the LLM is not in the loop. After a successful action the card's state persists (`completed`/`failed`, `state_note`, and disabled buttons all survive reloads) and a silent `[app-card] <label>: <title>` system note lands in the conversation history without waking the agent. A failed action never disables buttons - failures are retryable by design.

**Degrade behavior.** On a platform without card support, `_artifacts` is simply ignored and your JSON response works as before, so shipping cards is always safe. Rendering is **portal chat only** for now; mobile is a fast-follow.

**Tell your agent about cards in `docs[]`.** The agent never sees the card, but it does see your JSON response and the `[app-card]` notes. Two lines in your AI-facing docs (§2b) save a lot of noise:
- The user already sees an interactive card for this result - don't re-list its contents in prose; a one-line pointer to the card is enough.
- A `[app-card] <label>: <title>` note in the history means the user's action **already ran**. Don't re-execute it; acknowledge and move on.

**Common pitfalls:**
- **The markup guard is per-entry, not per-string.** One `<b>` in one field value silently drops the entire card. Run every user-sourced or third-party string through a sanitizer.
- **Unstable `card_id`.** The id keys the persisted state (completed/disabled survive reloads). Derive it from the subject (`order-${id}`), never from `Date.now()` or a random value, or every re-render mints a "new" card and prior state orphans.
- **Secrets in `args`.** Action args are stored with the conversation and replayed on click. Put an id in `args` and re-resolve tokens server-side in the handler; never a token, key, or password.
- **Oversized `panelData`.** 32KB serialized is the whole budget, and an over-budget card is dropped. Shed content in a defined order when a card runs large: drop images first, then trim table rows, and omit the card entirely rather than ship a broken one.
- **A card must never fail the tool.** Build it in a try/catch and omit `_artifacts` on any throw. The JSON response is the product; the card is a bonus.

## 3. The SDK (`@sprigr/apps-app-sdk`)

A small npm package (no runtime deps). Provides:

- `encodeState(obj)` / `decodeState(str)` - base64url state codec for OAuth + dispatch routing
- `randomHex(bytes)`, `hmacSha256Hex(key, data)`, `constantTimeEqual(a, b)` - Web Crypto wrappers
- `fetchWithRetry(url, init, options)` - exponential-backoff fetch (provider APIs rate-limit hard)
- Types: `D1Like`, `WebhookArgs`, `ScheduleArgs`, `EventArgs`, `HandlerFn`

Plus a companion `@sprigr/apps-oauth-utils` with:
- `exchangeCode(args)` - code → tokens
- `refreshAccessToken(args)` - race-safe refresh rotation
- `OAuthError` typed errors

And `@sprigr/apps-d1-kv` with `makeD1TokenStore` / `makeSettingsStore` (D1-backed token + settings stores over the scaffolded `<slug>_secrets` / `<slug>_settings` tables). The scaffolder exact-pins all of these.

## 4. The runtime env

Every per-install WFP script gets these bindings stamped at upload time:

| Binding | Type | Source | What for |
|---|---|---|---|
| `DB` | D1 | per-install, allocated on first build | Your per-install state (tokens, sync cursors, audit) |
| `KV` | KV namespace | per-install, allocated on first build | Cache / settings KV (optional, only emitted if used) |
| `IMAGES` | Workers Images binding | platform | Image transforms |
| `INSTALL_ID` | plain_text | the install id | OAuth state, webhook URLs, audit row stamping |
| `COMPANY_ID` | plain_text | the installing company id | Stamp on outbound requests |
| `APP_SLUG` | plain_text | your app slug | Self-identification in logs |
| `SPRIGR_INSTALL_TOKEN` | plain_text | HMAC, signed at upload | Bearer for `env.SPRIGR.*` calls back to platform |
| `SPRIGR_PLATFORM_BASE` | plain_text | env-aware URL | The platform API base for this environment |
| Plus every manifest `secrets[]` entry | secret_text | the install's secret store | Per-install OAuth keys, webhook signing keys, etc. |

Declare them in your env type so `getCloudflareContext({ async: true }).env` is typed:

```ts
// src/lib/env.ts
import type { D1Like } from '@sprigr/apps-app-sdk';

export interface MyEnv {
  DB: D1Like;
  PROVIDER_CLIENT_ID: string;
  PROVIDER_CLIENT_SECRET: string;
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  [key: string]: unknown;  // pacifies CloudflareEnv constraint
}

// GLOBAL AUGMENTATION - required, not optional. Without this,
// getCloudflareContext returns env: CloudflareEnv and every access
// like `env.PROVIDER_CLIENT_ID` is a TS error.
declare global {
  interface CloudflareEnv extends MyEnv {}
}
export {};
```

Then in routes / handlers:
```ts
// CORRECT - the type comes from the global augmentation
const { env } = await getCloudflareContext({ async: true });

// WRONG - getCloudflareContext<T>()'s generic is for CfProperties,
// not env. Easy to misread the type signature.
const { env } = await getCloudflareContext<MyEnv>();
```

## 5. The build / publish pipeline

### Publish
```bash
# from the app's directory (or with --dir apps/<slug> from the root)
sprigr app publish --dir .
```

What happens server-side:
1. The CLI POSTs `{ manifest, files: {path: content, ...} }` to the platform publish endpoint.
2. The platform validates the manifest, upserts the app record, and creates a new version row with the source files stored on it.
3. **No build yet** - publish only stages the source. Builds run per-install.

### Install
- A user clicks Install in the portal → the platform creates an install record → provisions the per-install website (slug shape `<appSlug>-<lastEightOfInstallId>`, e.g. `my-crm-5oema5wd`) → grants the installer access → enqueues a build job.
- The build-runner container picks up the job, runs `npm install` + the framework build (e.g. `opennext build` for Next.js), then uploads the bundle to WFP.
- The build-runner allocates the per-install D1 + KV if missing, then attaches all the bindings above.
- After upload, the platform runs the manifest's `migrations[]` against the per-install D1.

### Upgrade
- After publishing a new version, upgrade existing installs via the portal "Upgrade" banner or `sprigr app upgrade <slug>`.
- The install is re-pinned to the latest approved version and the build is re-enqueued with the same website id. The new WFP script replaces the old one; the install URL stays the same; per-install D1 + secrets are preserved.

## 6. OAuth - the shared bouncer pattern

Most third-party OAuth providers require a **single registered redirect_uri per dev-app registration**. But every install is a different URL (`my-crm-5oema5wd.apps.sprigr.com`, `my-crm-abc12345.apps.sprigr.com`, ...) - you can't register them all.

The Sprigr solution: a **shared bouncer worker** at one stable URL that decodes OAuth state, looks up the install, and dispatches the callback back to the right per-install WFP script via the dispatcher namespace.

```
                      register ONCE in the provider dev app:
                      https://oauth-bouncer.sprigr.com/my-crm/oauth/callback

  install URL                         Provider                    bouncer
  ───────────                         ────────                    ───────
  /oauth/start  ─builds authorize URL─►
                ◄──user consents───
                                       ─redirect_uri=bouncer─►
                                                                    decodeState(state)
                                                                    → state.installId
                                                                    dispatch to install {
                                                                      path: '/__sprigr/tool/my_crm_oauth_callback',
                                                                      body: { code, redirectUri, ... }
                                                                    }
                                                                    ──────────────────►
                                                                                         install runs
                                                                                         my_crm_oauth_callback
                                                                                         (exchanges code,
                                                                                          stores tokens in DB)
                                                                                         ◄──────────────────
                                                                    successPage()
                                                                  ◄──redirect to /─
```

Implementation rules:
- `/oauth/start` puts the `installId` in the state (from `env.INSTALL_ID`), encodes with `encodeState()`, and uses the bouncer URL as `redirect_uri`. Pick the bouncer URL by environment from the request host so one bundle serves every environment. The production bouncer is `https://oauth-bouncer.sprigr.com/<slug>/oauth/callback`; for local testing the CLI dev harness listens on `http://localhost:8666/<slug>/oauth/callback`. The scaffolder generates this environment-aware selection for you.
- The bouncer dispatches to `/__sprigr/tool/<app-slug-snake-case>_oauth_callback`. Your manifest **must** declare that tool (`my_crm_oauth_callback`) and point its `handler` at a module that takes `{ code, redirectUri, environment }` and exchanges the code with the provider.
- When exchanging the code, use the **bouncer's** `redirectUri` (passed in the args), not the install's own URL. Providers validate that the `redirect_uri` matches what was sent at `/oauth/start`.

Common failure modes:
- **"redirect uri is malformed or doesn't match"** → either you're hitting a stale OAuth state from before you fixed the redirect URI, OR the provider dev app hasn't been registered with the bouncer URL for that environment. Refresh, then check the address bar - `redirect_uri=oauth-bouncer.sprigr.com/...` is correct. Remember production and any pre-production environment use **different** bouncer URLs; register each.
- **`state.installId='unknown'`** → the install was built before `env.INSTALL_ID` was bound. Bump the app version and upgrade the install.
- **CSRF mismatch on callback** → the state's `csrf` isn't matching the install D1's `oauth_csrf` setting. Usually happens when you start two OAuth flows in parallel (each clobbers the other). Retry from scratch.

## 7. Local dev

The kit's CLI dev harness (`sprigr app dev --dir apps/<slug>`, CLI >= 0.2.0, Node >= 22.5) runs your **tool handlers and the entire OAuth callback loop** against a local SQLite-backed copy of your per-install D1 - before any publish, no Sprigr account needed. What it **cannot** run is the platform host object: every `env.SPRIGR.*` method throws locally, and webhook/schedule dispatch plus the build pipeline only exist on the platform. So the final shakedown is still: publish, install, click through.

Workflow:
1. Edit + typecheck locally (`pnpm -F <slug> typecheck && pnpm -F <slug> test && pnpm -F <slug> build`), and `pnpm verify:local` for the vendor-drift + migration guards.
2. `sprigr app dev --dir apps/<slug>` to exercise handlers + the OAuth loop locally.
3. `sprigr app publish --dir apps/<slug>`.
4. Install from the portal marketplace tab and verify at `https://<slug>-<id>.apps.sprigr.com/`.

For the full local-vs-platform split of every capability family, see the [capability cookbook](capability-cookbook.md).

## 8. CLI / API auth

The CLI stores credentials at `~/.config/sprigr/credentials.json` (file mode 0600), written by `sprigr login` (a device flow - no password ever touches the terminal). Verify with `sprigr whoami`.

```json
{
  "apiKey": "sk_...",
  "keyPrefix": "sk_xxxx",
  "keyId": "mkey_...",
  "companyId": "comp_...",
  "userId": "user_...",
  "endpoint": "https://api.team.sprigr.com",
  "loggedInAt": "..."
}
```

API auth: `Authorization: Bearer <apiKey>` plus an optional company-id header (defaults to the credential's `companyId`).

## 9. Surface checklist for a new app

Minimum viable marketplace app (the scaffolder generates all of these - this is what to verify):
- [ ] `apps/<slug>/sprigr-app.json` - manifest with `kind: integration`, `runtime.tier: ssr`, `runtime.framework: next`
- [ ] `apps/<slug>/package.json` - npm-installable, NO `workspace:*` deps; `@sprigr/apps-*` exact-pinned
- [ ] `apps/<slug>/migrations/0001_init.sql` - per-install schema
- [ ] `apps/<slug>/docs/*.json` + `docs[]` in the manifest - AI-facing docs so agents discover your tools by search (see §2b)
- [ ] `apps/<slug>/src/lib/env.ts` - `declare global { interface CloudflareEnv extends YourEnv {} }`
- [ ] `apps/<slug>/src/app/page.tsx` - settings UI (data-bound via `getCloudflareContext({ async: true })`), with try/catch around the cold-install DB read
- [ ] `apps/<slug>/src/app/oauth/start/route.ts` - if you have OAuth (environment-aware bouncer URL!)
- [ ] `apps/<slug>/src/handlers/<slug>_oauth_callback.ts` - dispatched by the bouncer
- [ ] `apps/<slug>/src/handlers/<tool>.ts` - one per `tools[]` entry

Test plan:
1. `sprigr app validate --dir apps/<slug>` - manifest schema gate (no login needed).
2. `sprigr app dev --dir apps/<slug>` - exercise handlers + the OAuth loop against local D1.
3. `sprigr app publish --dir apps/<slug>` - first publish creates the app record.
4. Install via the portal Marketplace tab. Confirm the install URL renders.
5. If OAuth: click Connect, follow the redirect, log into the provider, confirm `state.installId` decodes to your install id (not `unknown`).
6. Confirm tokens land in your per-install D1's `<slug>_secrets` table.
7. Exercise a tool through an agent chat and confirm it fires.

## 10. Further reading in this kit

| What | Where |
|---|---|
| Zero-to-published setup (account, CLI, first publish) | [docs/getting-started.md](getting-started.md) |
| Step-by-step app walkthrough (agent-followable) | [docs/build-guide.md](build-guide.md) |
| Capability coverage index (manifest field → sample → local/staging → exemplar) | [docs/capability-cookbook.md](capability-cookbook.md) |
| Publishing the kit packages to npm (maintainers) + why exact pins | [docs/publishing.md](publishing.md) |
| Faceted-search catalog UI | [docs/faceted-search.md](faceted-search.md) |
| Complete reference app (real OAuth provider) | [examples/harvest](../examples/harvest) |
| Every-feature synthetic reference app | [examples/showcase](../examples/showcase) |

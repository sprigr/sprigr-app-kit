# Capability cookbook

The index for **every** marketplace-app capability the platform exposes. One row per capability family: the manifest field(s) that declare it, the kit sample file that exercises it, what runs under `sprigr app dev` locally vs what needs staging, and the best production exemplar in [sprigr/sprigr-apps](https://github.com/sprigr/sprigr-apps) to copy from.

This is a map, not a tutorial. For the end-to-end build flow read [build-guide.md](build-guide.md); for exact field semantics read [platform-reference.md](platform-reference.md). When you need feature X, find its row here, open the sample file, and copy the one capability you need.

## The reference apps

- **[`examples/showcase`](../examples/showcase)** — a synthetic every-feature app (provider persona: the fictional "Acme CRM"). Its [`sprigr-app.json`](../examples/showcase/sprigr-app.json) declares every manifest field family, and its handlers under [`src/handlers/`](../examples/showcase/src/handlers) exercise every `env.SPRIGR.*` call. Grouped by capability so you can read one file per concern.
- **[`examples/showcase-consumer`](../examples/showcase-consumer)** — the CONSUMER side: calling another app's cross-tenant tool, subscribing to its cross-tenant event, and the install-config override pattern.
- **[`examples/agent-template`](../examples/agent-template)** — the OTHER app shape: `kind: 'agent'`. Ships no Worker and no tools; installing it provisions a configured agent (persona, model tier, role, channel defaults, recommended apps, training index).
- **[`examples/static-badge`](../examples/static-badge)** — the simplest valid app: `runtime.tier: 'static'`, no Worker, no build.
- **[`examples/harvest`](../examples/harvest)** — the realistic single-integration starter (real OAuth, real provider API). The scaffolder (`pnpm create:app`) generates this shape.

## Local vs staging (the split every row keys off)

`sprigr app dev` runs your **handlers + the OAuth callback loop** against a **local SQLite D1** (`env.DB`) with your manifest migrations applied. What it CANNOT run is the platform host object: **every `env.SPRIGR.*` method throws** under the harness (the stub points you at staging). The showcase handlers wrap those calls in a `stagingOnly()` helper ([`src/lib/env.ts`](../examples/showcase/src/lib/env.ts)) that catches the throw and returns `{ ok: false, staging_only: true, hint }`, so local dispatch stays clean and the author sees exactly which call needs staging. Anything marked **staging** below is `env.SPRIGR.*`; anything marked **local** is pure logic or `env.DB`.

## Coverage matrix

| Capability | Manifest field(s) | Kit sample | Local / staging | Best sprigr-apps exemplar |
|---|---|---|---|---|
| Dispatcher tool (one tool, many actions) | `tools[].input_schema`, `dispatch.actionField/actions/actionInputs` | [`handlers/dispatcher.ts`](../examples/showcase/src/handlers/dispatcher.ts) | local (validation, D1) + staging (data.*) | `simpro` (dispatcher in handler code; no app uses the `dispatch` field yet) |
| Tool output schema | `tools[].output_schema` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) `showcase` tool | n/a (declaration) | — (no app declares `output_schema` yet) |
| Content idempotency | `tools[].idempotency` | `showcase` tool (`cache_contact`) | n/a (platform-enforced) | — (no app declares `idempotency` yet) |
| Confirmation-required tool | `tools[].confirmation_required` | `showcase` tool | n/a (agent-enforced) | `linkedin` |
| Internal (job-step) tool | `tools[].internal: true` | `showcase_backfill_step` + all webhook/channel/schedule tools | n/a | — (no app declares `internal: true` yet) |
| OAuth via publisher bouncer | `secrets[]` + `/oauth/start` route + `<slug>_oauth_callback` tool | [`app/oauth/start/route.ts`](../examples/showcase/src/app/oauth/start/route.ts), [`handlers/config.ts`](../examples/showcase/src/handlers/config.ts) | **local** (whole callback loop) | `simpro`, `email-imap-pop` |
| Provider-initiated (inbound) install | `oauth.inbound_install` (+ `import_tool`) | [`handlers/config.ts`](../examples/showcase/src/handlers/config.ts) `showcase_inbound_import` | local (persist) + staging (jobs.start) | — (no app declares `inbound_install` yet) |
| Publisher-provided secret | `secrets[].publisher_provides` | `ACME_CLIENT_ID/_SECRET` | n/a (seed via `set-publisher-secrets`) | `shopify`, `intabot` |
| Auto-generated secret | `secrets[].auto_generate` | `SHOWCASE_STATE_HMAC_KEY` | n/a (server-minted) | `email-imap-pop` |
| Brand-supplied secret | `secrets[]` (default) | `ACME_WEBHOOK_SECRET` | n/a (install-time) | `simpro` |
| Migrations (multi-file chain) | `migrations[]` | [`migrations/0001_init.sql`](../examples/showcase/migrations/0001_init.sql), [`0002_install_config.sql`](../examples/showcase/migrations/0002_install_config.sql) | **local** (applied by harness) | every app |
| D1 settings / token stores | (uses `@sprigr/apps-d1-kv`) | [`lib/store.ts`](../examples/showcase/src/lib/store.ts) | **local** | `harvest` |
| Install-config override | `config_schema` + D1 UPSERT | [`lib/store.ts`](../examples/showcase/src/lib/store.ts) `setInstallConfig`, consumer [`lib/store.ts`](../examples/showcase-consumer/src/lib/store.ts) | **local** | — (private connectors; no public exemplar) |
| AI-facing docs | `docs[]` → `docs/*.json` | [`docs/tools.json`](../examples/showcase/docs/tools.json) | n/a (ingested at publish) | — (no app ships `docs[]` yet) |
| Webhook: HMAC hex | `webhooks[]` (`signature.encoding: hex`) | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) `onContact` | local (verify + dedup) + staging (data.import) | `simpro`, `hello-marketplace` |
| Webhook: HMAC base64 | `webhooks[]` (`signature.encoding: base64`) | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) `onDeal` | local (verify) + staging (emit) | `shopify` |
| Webhook: install-token bearer | `webhooks[]` (`signature.type: install_token`) | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) `onBookmarklet` | **local** | — (no app uses `install_token` yet) |
| Webhook: shared (app-level fan-out) | `webhooks[].shared` + `registerWebhookTenant` | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) `onShared` / `registerSharedTenant` | local (verify) + staging (registerWebhookTenant) | — (no app declares `shared` yet) |
| Webhook dedup | (uses `@sprigr/apps-dedup-latch`) | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) | **local** | `shopify` |
| Conversational channel | `channels[]` (receive/send/identity + supports) | [`handlers/channel.ts`](../examples/showcase/src/handlers/channel.ts) | local (verify/decode) + staging (inbox.append) | — (no app declares `channels[]` yet) |
| Schedule (per_install) | `schedules[]` (`scope: per_install`) | [`handlers/platform.ts`](../examples/showcase/src/handlers/platform.ts) `dailyDigest` | staging (usage.report, schedules.create) | `linkedin`, `email-imap-pop` |
| Schedule (per_tenant) | `schedules[]` (`scope: per_tenant`) | [`handlers/platform.ts`](../examples/showcase/src/handlers/platform.ts) `tenantRollup` | staging (data.search) | — (no app uses `per_tenant` yet) |
| Durable job (step directives) | `jobs[]` (+ `retries`) | [`handlers/jobs.ts`](../examples/showcase/src/handlers/jobs.ts) | **local** (state machine) — page-fetch/import staging | — (no app declares `jobs[]`; `shopify` does the same work via self-rescheduling `schedules.create`) |
| Resumable paged backfill | (uses `@sprigr/apps-sync-cursor`) | [`handlers/jobs.ts`](../examples/showcase/src/handlers/jobs.ts) `runResumablePage` | **local** | `simpro` (sync-cursor) |
| Agent-side schedule | `agent_schedules[]` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) `showcase_engagement_sync` | n/a (fires an agent prompt) | `intabot` |
| Events: emit | `events.emits[]` | [`handlers/webhooks.ts`](../examples/showcase/src/handlers/webhooks.ts) `onDeal` (emit) | staging (emit) | `shopify`, `simpro`, `procore` |
| Events: subscribe (+ filter) | `events.subscribes[]` | [`handlers/events.ts`](../examples/showcase/src/handlers/events.ts), consumer [`handlers/enrich.ts`](../examples/showcase-consumer/src/handlers/enrich.ts) | local (dedup) + staging (data.import) | `cross-tenant-demo` |
| Events: cross-tenant emit | `events.cross_tenant_emits[]` | [`handlers/cross-tenant.ts`](../examples/showcase/src/handlers/cross-tenant.ts) `emitDealWonCrossTenant` | staging (emit) | `cross-tenant-demo` |
| Cross-tenant tool (provider side) | `cross_tenant_tools[]` | `showcase_lookup_contact` declaration | n/a | `shopify` |
| Cross-tenant tool (consumer side) | `app_dependencies[]` + `env.SPRIGR.invoke` | consumer [`handlers/enrich.ts`](../examples/showcase-consumer/src/handlers/enrich.ts) | staging (invoke) | — (no app declares `app_dependencies` yet) |
| Integration dependency | `integration_dependencies[]` + `integrations.invoke` | [`handlers/cross-tenant.ts`](../examples/showcase/src/handlers/cross-tenant.ts) `correlateShopifyOrder` | staging (integrations.invoke) | — (no app declares `integration_dependencies` yet) |
| Fulfillment services | `fulfillment_services[]` + `fulfillment_services.register` | [`handlers/data-and-collections.ts`](../examples/showcase/src/handlers/data-and-collections.ts) `registerWarehouse` | staging | — (no app declares `fulfillment_services` yet) |
| Workflow template | `workflow_templates[]` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) `deal_won_intake` | n/a (instantiated on install) | `hello-marketplace`, `cross-tenant-demo` |
| Decision point | `decision_points[]` + `run_workflow` | [`handlers/platform.ts`](../examples/showcase/src/handlers/platform.ts) `routeDecision` | local (fallback) + staging (run_workflow) | — (no app declares `decision_points` yet) |
| Data index (per-company) | `data_index` + `data.import/search/get` | [`handlers/data-and-collections.ts`](../examples/showcase/src/handlers/data-and-collections.ts) | staging | `linkedin`, `intabot` |
| Collections | (scope `sprigr.collections`) + `collections.*` | [`handlers/data-and-collections.ts`](../examples/showcase/src/handlers/data-and-collections.ts) | staging | — (no public exemplar) |
| Company / publisher store | scope `sprigr.jobs` / `sprigr.jobs:publisher` + `store.*` | [`handlers/store.ts`](../examples/showcase/src/handlers/store.ts) | staging | — (no app uses `env.SPRIGR.store` yet) |
| Browser fetch / screenshot | scope `sprigr.browser:fetch` + `browser.fetch/screenshot` | [`handlers/browser.ts`](../examples/showcase/src/handlers/browser.ts) | staging | — (no app uses `env.SPRIGR.browser` yet) |
| Browser session (stateful) | scope `sprigr.browser:session` (+ `sprigr.jobs:publisher`) | [`handlers/browser.ts`](../examples/showcase/src/handlers/browser.ts) `driveLoginPortal` | staging, **publisher-owner only** | — (publisher-owner only; no public exemplar) |
| Inbox append | scope `inbox:write` + `inbox.append` | [`handlers/channel.ts`](../examples/showcase/src/handlers/channel.ts) `identity` | staging | `email-imap-pop` |
| Files (R2) | `files.putStream` / `files.url` | [`handlers/files.ts`](../examples/showcase/src/handlers/files.ts) | staging | — (no app uses `env.SPRIGR.files` yet) |
| Usage metering | `usage.report` | [`handlers/platform.ts`](../examples/showcase/src/handlers/platform.ts) `dailyDigest` | staging | — (no app uses `usage.report` yet) |
| Register channel (shared routing) | `registerChannel` | [`handlers/cross-tenant.ts`](../examples/showcase/src/handlers/cross-tenant.ts) `registerChatWorkspace` | staging | — (no app uses `registerChannel` yet) |
| Lifecycle hooks | `lifecycle.on_connect/on_disconnect` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) | n/a | — (no app declares `lifecycle` yet) |
| Tool access policy | `tool_access` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) | n/a | — (no app declares `tool_access` yet) |
| Content restrictions (prompt rules) | `content_restrictions.rules[]` | [`sprigr-app.json`](../examples/showcase/sprigr-app.json) | n/a (injected into agent prompts) | — (no app declares `content_restrictions` yet) |
| Agent template app | `kind: 'agent'` + `agent_config` (persona/model_tier/role/settings/channels/recommended_apps) | [`examples/agent-template`](../examples/agent-template) | n/a (provisions an agent at install) | `intabot` |
| Agent training index | `training_index` | [`agent-template/sprigr-app.json`](../examples/agent-template/sprigr-app.json) | n/a (index provisioned at publish) | — (no app declares `training_index` yet) |
| Job lifecycle (start/get/list/cancel/signal) | `jobs[]` + `jobs.*` | [`handlers/jobs.ts`](../examples/showcase/src/handlers/jobs.ts) | staging | — (no app declares `jobs[]` yet) |
| Fulfillment service update / delete | `fulfillment_services[]` + `fulfillment_services.update/delete` | [`handlers/data-and-collections.ts`](../examples/showcase/src/handlers/data-and-collections.ts) | staging | — (no app declares `fulfillment_services` yet) |
| Static tier (no Worker) | `runtime.tier: 'static'`, `framework: 'static'` | [`examples/static-badge`](../examples/static-badge) | n/a (served from R2) | — (no public static-tier app yet) |

### Reading the exemplar column

A dash means **no app in [sprigr-apps](https://github.com/sprigr/sprigr-apps) uses that capability yet** — the platform supports it, the manifest validator accepts it, but nobody has shipped it in the public marketplace. Roughly half the surface is in that state today. For those rows the kit sample is your only worked reference, so read it closely and expect to be the first to exercise the path on staging. Rows naming an app have been verified against that app's live manifest.

## Completeness

Every method the marketplace `env.SPRIGR` host object implements — **37** across 13 groups — is called by a sample under `examples/`, and every field the platform's `AppManifest` accepts is declared by one of the four example manifests. If the platform grows a method or a field and the kit doesn't follow, that is a real gap rather than a judgement call.

Two things remain that no sample can fully exercise, for platform reasons:

- **`env.SPRIGR.browser.session.*`** is called and typed ([`handlers/browser.ts`](../examples/showcase/src/handlers/browser.ts) `driveLoginPortal`), but it is **publisher-owner-only**: only the install where `company_id === publisher_company_id` may open a publisher-scoped session, and every other install gets `403 not_publisher_owner`. The sample shows the exact call sequence — you just have to run it from the publisher's own install, even on staging.
- **`files.edit` / `files.create` / `files.extract`** (the document-engine twins) are **not** in the marketplace wrapper at all: `env.SPRIGR.files` exposes only `putStream` and `url`. Binary text extraction inside a workflow goes through the agent's `files.extract`, not `env.SPRIGR`. There is nothing here to sample.

One manifest field is deliberately absent. **`auth`** (the pre-2026 `{ type: 'api_key', fields: [...] }` block) still exists in the platform's TypeScript types but has **no server-side consumer** — nothing reads `manifest.auth` at publish or install time. Collect credentials with `secrets[]`, and use `oauth` plus the shared bouncer for OAuth providers.

## Shared packages used

The showcase handlers consume the kit's published packages via exact-pinned npm deps (same convention as harvest): `@sprigr/apps-app-sdk` (`hmacSha256Hex`, `constantTimeEqual`, `bytesToBase64`, `encodeState`/`decodeState`), `@sprigr/apps-dedup-latch` (webhook dedup), `@sprigr/apps-sync-cursor` (`runResumablePage` paged backfill), `@sprigr/apps-webhook-registry` (shared-webhook tenant map), `@sprigr/apps-d1-kv` (settings/token stores). See [`examples/showcase/package.json`](../examples/showcase/package.json).

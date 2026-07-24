# Build a Sprigr Marketplace App: Step-by-Step Guide

A self-contained walkthrough for a developer or AI agent building a complete Sprigr marketplace app, including a full OAuth connection to an external system, using this kit's shared packages, scaffolder, and reference app.

The worked example throughout is [examples/harvest](../examples/harvest), a complete OAuth integration against Harvest (time tracking): manifest, migrations, OAuth via the Sprigr bouncer, token refresh, agent tools, AI-facing docs, tests. Every pattern in this guide exists in that app; when in doubt, read the corresponding file there.

The deep reference for the manifest schema, runtime bindings (`env.SPRIGR.*`), and the publish pipeline is [platform-reference.md](platform-reference.md); "reference §N" below points into it.

---

## 0. Prerequisites

1. A Sprigr publisher account and the `sprigr` CLI, logged in (`sprigr login`; credentials land in `~/.config/sprigr/credentials.json`). Reference §8.
2. Your app slug (kebab-case, unique on the marketplace). Everything keys off it: install URLs, OAuth callback routing, tool namespacing.
3. OAuth apps only: a developer-app registration with your external provider. You will register the Sprigr bouncer redirect URIs there (step 2 below).
4. This kit checked out; `pnpm install` at the root. Node 20+.

> Bouncer routing for a new slug is path-based (`/<slug>/oauth/callback`); confirm with Sprigr platform support (platform@sprigr.com) that your publisher slug is enabled for the shared bouncer before your first OAuth shakedown.

---

## 1. Ground rules (the mistakes that hurt)

1. **NEVER edit a migration file after a version that includes it has been published** (`apps/*/migrations/*.sql`), not even a comment. The platform records each migration's sha256 per install when it applies it; changing a byte blocks every existing install from upgrading, silently. Schema changes go in a NEW numbered file (`0002_*.sql`). While your app is unpublished, edit `0001_init.sql` freely. The guard: `pnpm verify:local` (also run it before every publish).
2. **A publish ships nothing unless `metadata.version` moved.** `pnpm bump <slug> [patch|minor|major]` moves `sprigr-app.json` and `package.json` together.
3. **Shared code is vendored, not workspace-imported.** The marketplace build-runner installs your app's `package.json` with plain `npm` in a sandbox: no monorepo, no `workspace:*`. Declare kit packages in your app's `package.json` `sprigrVendor` array, run `pnpm sync:vendor`, and import from the relative `src/lib/vendor/<pkg>/` mirror. `pnpm sync:vendor:check` catches drift.
4. **Real OAuth and per-install databases only exist on the platform.** Local `pnpm dev` is for UI iteration and typecheck; the shakedown loop is publish, install, click through (step 9).

---

## 2. What you are building

A marketplace app is a **Next.js app** running on Cloudflare Workers-for-Platforms, one isolated script per install, in `apps/<slug>/`:

- `sprigr-app.json`: the manifest (metadata, secrets, tools, schedules, migrations). Single source of truth, validated server-side at publish.
- `migrations/0001_init.sql`: per-install D1 schema. Every install gets its own D1 database bound as `env.DB`.
- `src/app/`: the Next.js settings UI plus the `/oauth/start` route.
- `src/handlers/`: modules the platform dispatches into (agent tools, the OAuth callback, scheduled jobs, webhooks).
- `src/lib/`: your provider client, OAuth glue, and the `vendor/` mirror of kit packages.

The platform provides per-install bindings at build time: `DB` (D1), every manifest `secrets[]` entry, `INSTALL_ID`, `COMPANY_ID`, `APP_SLUG`, `SPRIGR_INSTALL_TOKEN`, `SPRIGR_PLATFORM_BASE`, and (inside dispatched handlers only) the `env.SPRIGR` host object for platform callbacks (events, collections, search index, file storage, cross-app calls). Full table: reference §4.

### OAuth in one diagram

You cannot register every install's URL as a redirect URI with your provider. One stable redirect URI per environment points at the Sprigr **OAuth bouncer**, which decodes the `state` parameter to find the install and dispatches the callback into it:

```
install settings UI                    provider                bouncer (stable URL)
   GET /oauth/start ── authorize URL ──►
                     ◄─ user consents ─
                                        ── redirect_uri=bouncer ──►
                                                                   decodeState(state).installId
                                                                   dispatch /__sprigr/tool/<slug>_oauth_callback
                                                                   { code, state, redirectUri, environment, installId }
                                                                            │
                                                    install's callback handler verifies csrf,
                                                    exchanges the code, persists tokens in its D1
```

Bouncer URLs (the only redirect URIs you ever register with the provider):

- Prod: `https://oauth-bouncer.sprigr.com/<slug>/oauth/callback`
- Staging: `https://staging-oauth-bouncer.sprigr.com/<slug>/oauth/callback`

---

## 3. Step 1: collect provider facts

Fill this in from your provider's developer docs before writing code:

| Fact | Harvest example | You need it for |
|---|---|---|
| Authorize endpoint | `https://id.getharvest.com/oauth2/authorize` | `src/lib/oauth.ts` |
| Token endpoint | `https://id.getharvest.com/api/v2/oauth2/token` | `ProviderConfig.tokenUrl` |
| Revoke endpoint (if any) | | disconnect flow |
| Scopes and how they are requested | | authorize URL params |
| Token semantics | rotating refresh tokens | pattern choice, step 6a |
| Sandbox environment | | environment switch |
| API base URL(s) | `api.harvestapp.com` | client + `network_domains` |
| Extra API requirements | `Harvest-Account-Id` + `User-Agent` headers | client |

Register your developer app with the provider using **both** bouncer redirect URIs. If the provider allows only one redirect URI per registration, create one registration per environment and note that client id/secret then differ per environment.

Client id/secret handling: declare them as manifest `secrets[]`. If you (the publisher) run one shared OAuth app for all installs, seed them once with `sprigr app set-publisher-secrets` after the first publish and mark them `"publisher_provides": true`. If each installing tenant brings their own OAuth app, leave that off; the installer pastes them in the portal.

> Never commit real credentials to the repo or paste them into logs. They live in the platform's secret store only.

---

## 4. Step 2: scaffold

```bash
pnpm create:app <slug>                         # OAuth integration (default)
pnpm create:app <slug> --kind tool --no-oauth  # pure tool app, no OAuth
pnpm install                                   # register the new workspace package
```

The scaffolder generates the full skeleton: manifest, `package.json` with `sprigrVendor` pre-declared, `migrations/0001_init.sql` (settings + secrets key-value tables), `src/lib/env.ts` (typed bindings with the required `CloudflareEnv` global augmentation), `src/lib/store.ts`, `src/lib/oauth.ts` stub, `src/app/oauth/start/route.ts` (environment-aware bouncer URL, CSRF minting), `src/handlers/oauth-callback.ts` (csrf verification + token exchange), a tool handler stub, a settings page, and a smoke test. It runs the vendor sync and prints a TODO checklist.

Don't hand-copy the harvest example into a new app; scaffold, then use harvest to see how each TODO was filled for a real provider.

---

## 5. Step 3: complete the manifest

Open `apps/<slug>/sprigr-app.json`. Full schema: reference §2. Always touch:

- `metadata`: description, category, tags. Agents and the marketplace listing read these.
- `permissions.network_domains`: every host you call, including the OAuth login host. Declarative (not a runtime firewall), but the platform's inbound-OAuth SSRF guard and agent sandbox read it.
- `secrets[]`: `<PREFIX>_CLIENT_ID`, `<PREFIX>_CLIENT_SECRET`, plus the scaffolded `INTERNAL_TRIGGER_SECRET` if you expose internal trigger routes.
- `tools[]`: one entry per agent-callable tool plus the `<slug>_oauth_callback` entry. Write real descriptions; agents pick tools by them.
- `schedules[]`: the scaffolder does NOT generate one; for refresh-token providers, declare a token-refresh cron yourself (snippet in step 6d). Non-expiring-token providers skip it.
- `docs[]`: AI-facing doc JSON files (see [examples/harvest/docs/tools.json](../examples/harvest/docs/tools.json)); the platform ingests them into a per-app search index so agents learn your tools. Authoring rules and caps: reference §2b.

Validation gotchas that reject a publish (details: reference §2):

- `secrets[].type` must be `"secret"`, never `"string"`.
- `schedules[].name` must be snake_case, and keep `name` equal to `tool`.
- `schedules[].scope` must be `"per_install"` or `"platform"`.
- `schedules[].tool` must reference a `tools[]` entry that has a `handler`.
- `runtime.tier` is required (`"ssr"` for Next.js).
- `tools[].handler` paths are relative to the app dir.
- A tool other apps may call via `env.SPRIGR.integrations.invoke` must ALSO be in `cross_tenant_tools[]`, or callers get `400 unknown_tool`.

---

## 6. Step 4: implement OAuth

### 6a. Pick your pattern

| Provider shape | Pattern |
|---|---|
| One connection per install, standard refresh tokens | Install-level: the scaffold default and the harvest example. Start here. |
| Each user/agent connects their own account | Per-actor: same primitives, but the token table keys rows by actor id, and `/oauth/start` carries the actor in the state. |
| Short-lived access tokens with single-use rotating refresh tokens | The kit's `oauth-utils` already persists the rotated refresh token first and retries once on a stale-token race; keep your own writes in that order too. |
| Non-expiring access token, no refresh token at all (Todoist, GitHub OAuth apps) | Pass `allowNoRefreshToken: true` to `exchangeAndPersist`; it stores `expires_at = 'never'` and `getValidAccessToken` serves the cached token without a refresh cycle. No refresh cron needed. If the provider revokes the token, API calls 401: surface a reconnect. |
| Incremental scope expansion | Track granted scopes per connection (persist `AuthCodeResponse.scope`); pass the provider's incremental-consent param on reconnect. |

### 6b. The kit primitives (do not reimplement these)

From `src/lib/vendor/oauth-utils` ([packages/oauth-utils/src](../packages/oauth-utils/src)):

- `exchangeAuthCode(config, code, opts)`: authorization code to tokens.
- `exchangeAndPersist(config, store, code, opts)`: exchange plus race-safe persistence (refresh token written first). Returns `AuthCodeResponse { accessToken, refreshToken, expiresIn, scope? }`.
- `getValidAccessToken(config, store)`: THE runtime entry point. Returns a cached access token if not near expiry, otherwise refreshes and persists. Call it at the top of every provider API call.
- `refreshOAuthToken` / `refreshAndPersist`: the underlying refresh cycle; handles rotating refresh tokens.
- `OAuthError` with machine-readable `reason` (`revoked`, `network`, ...): distinguishes "user must reconnect" from transient failure.
- `ProviderConfig { provider, tokenUrl, clientId, clientSecret }` and `TokenStore { get, put, delete? }`: the two shapes you supply.

Two facts to know up front:

- The token store key names are fixed: `refresh_token`, `access_token`, `expires_at`. Your D1 rows hold exactly those keys (`expires_at` is the string `'never'` for non-expiring providers).
- `exchangeAuthCode` **throws** if the token response has no `refresh_token`, unless you pass `allowNoRefreshToken: true` (the non-expiring-provider pattern above). Providers that only issue a refresh token on first consent need the forcing params on the authorize URL (`access_type=offline`, `prompt=consent` or equivalent).

From `src/lib/vendor/d1-kv`: `makeD1TokenStore({ db, table })` and `makeSettingsStore({ db, table })`, D1-backed stores over the scaffolded `<slug>_secrets` / `<slug>_settings` tables.

From `src/lib/vendor/app-sdk`: `encodeState`/`decodeState` (the bouncer decodes YOUR state, so always build it with `encodeState`), `randomHex`, `hmacSha256Hex` + `constantTimeEqual` (webhook signatures), `fetchWithRetry` (rate-limited provider APIs).

Why tokens live in D1 and not manifest secrets: manifest `secrets[]` are read-only at runtime, and refresh rotation needs writes. Per-install D1 is isolated and encrypted at rest.

### 6c. The four files you fill in

The scaffolder generates all four with TODOs; the harvest example shows them filled for a real provider.

**1. `src/lib/oauth.ts`** ([harvest](../examples/harvest/src/lib/oauth.ts)): the provider endpoints, `buildAuthorizeUrl` (add provider-required params: scope, audience, ...), and `completeOAuthCallback` which calls `exchangeAndPersist` and records anything refresh needs later (environment, account id).

**2. `src/lib/store.ts`**: pins the vendored stores to your app's table names. Generated; rarely needs edits.

**3. `src/app/oauth/start/route.ts`** ([harvest](../examples/harvest/src/app/oauth/start/route.ts)): already complete from the scaffold. What it does and why:

- Reads `env.INSTALL_ID` and packs it into the state: this is how the bouncer finds the install.
- Refuses to restart when already connected unless `?reconnect=1` (a drive-by GET must not clobber a pending CSRF).
- Mints a CSRF (`randomHex(16)`), stores it in D1 as `oauth_csrf`, includes it in the state.
- Picks the bouncer URL by environment from the request host (`staging-apps.sprigr.com` means staging) so one bundle serves both environments.

**4. `src/handlers/oauth-callback.ts`** ([harvest](../examples/harvest/src/handlers/oauth-callback.ts)): the tool the bouncer dispatches with `{ code, state, redirectUri, environment, installId }`. The scaffolded version verifies the state's `csrf` against the stored `oauth_csrf` (returning `{ ok: false, error: 'expired_or_unknown_csrf' }` on mismatch, which the bouncer renders as a real error page instead of a false success), then exchanges and persists. Add your post-connect setup after the exchange: resolve the provider account, cache reference data for the settings UI, mint a webhook secret (only if none exists: a reconnect must not rotate a secret the provider still sends), register webhooks. Audit failures somewhere queryable.

Rule: when exchanging the code, use the **bouncer's** `redirectUri` from the dispatch args, not the install's own URL. Providers validate that it matches the authorize step.

### 6d. Runtime token access, refresh, disconnect

- One wrapper so handlers just call `getAccessToken(env)`: build the `ProviderConfig`, hand it `getValidAccessToken(config, makeD1TokenStore(env.DB))`. See [harvest's client](../examples/harvest/src/lib/harvest.ts).
- For refresh-token providers, declare a refresh cron in the manifest and a handler that calls your `getAccessToken(env)`; it keeps refresh tokens warm (some providers expire unused ones). The manifest entry:

  ```jsonc
  "schedules": [
    { "name": "refresh_tokens", "cron": "*/45 * * * *", "tool": "refresh_<slug>_tokens", "scope": "per_install" }
  ]
  ```

  plus a `tools[]` entry named `refresh_<slug>_tokens` whose handler default-exports `{ refresh_<slug>_tokens: async (_args, env) => { await getAccessToken(env); return { ok: true }; } }` (catch `OAuthError` and audit failures rather than throwing). Keep `name` equal to `tool`.
- Disconnect: best-effort revoke at the provider, then wipe the token rows. Report partial success rather than failing the wipe on a network error.

---

## 7. Step 5: implement your tools

Each `tools[]` entry points at a handler in `src/handlers/` whose default export maps tool name to `async (args, env) => result`. Inside:

- Get a token via your `getAccessToken(env)`; catch `OAuthError` with `reason: 'revoked'` and return a clear "reconnect required" message.
- Validate args before any network call; return typed errors agents can act on.
- `env.DB` is your per-install D1. `env.SPRIGR` (dispatched handlers only, NOT inline Next.js routes) is the platform surface: `emit`, `collections.*`, `data.*`, `files.*`, `integrations.invoke`, and more (reference §4).
- **Never rebuild the env by spread**: `{ ...env }` on the dispatch path yields `env.DB === undefined` (the bindings live on the prototype). Use plain property access; overlay with `Object.create(env)` if needed.
- Declare `idempotency` on costly or side-effectful tools so a model double-call collapses to one execution (reference §2). Don't retry POSTs in your fetch wrapper for the same reason.
- Provider webhooks: verify signatures with `hmacSha256Hex` + `constantTimeEqual`.

---

## 8. Step 6: settings UI and local verification

`src/app/page.tsx`: show connection status, a Connect button to `/oauth/start` (and a `?reconnect=1` variant), and provider-specific pickers. Wrap the initial load in try/catch: on a cold install the migrations may not have run yet.

Inline routes get env via `const { env } = await getCloudflareContext({ async: true })`. Do NOT pass a generic type parameter (it is not for env); typing comes from the scaffolded global `CloudflareEnv` augmentation in `src/lib/env.ts`.

Verify:

```bash
pnpm -F <slug> typecheck && pnpm -F <slug> test && pnpm -F <slug> build
pnpm verify:local     # vendor drift + migration immutability
```

---

## 9. Step 7: publish and shake down

```bash
sprigr app validate --dir apps/<slug>    # manifest schema gate
sprigr app publish --dir apps/<slug>     # stages the version server-side
```

Publish stages source; builds run per-install (install or upgrade triggers a build). Reference §5 has the pipeline and the direct curl commands for triggering upgrades and polling build status.

First-time OAuth shakedown:

1. Install the app from the marketplace tab of your portal. Confirm the install URL renders.
2. Seed publisher secrets if you use them: `sprigr app set-publisher-secrets --slug <slug> <PREFIX>_CLIENT_ID=... <PREFIX>_CLIENT_SECRET=...`
3. Click Connect; sign in at the provider; you should land back on a bouncer success page and see the app connected.
4. Confirm tokens landed: the settings page's connected state is the proxy for rows in `<slug>_secrets`.
5. Exercise one tool end to end via an agent.

Subsequent releases: `pnpm bump <slug> patch`, `pnpm verify:local`, publish, then upgrade installs (portal Upgrade banner or the upgrade endpoint).

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tool returns `no_handler` | Install serves an old bundle; often an upgrade blocked by an edited shipped migration | Restore the migration byte-exact; bump + republish |
| Cross-app call returns `400 unknown_tool` | Tool not in `cross_tenant_tools[]` | Add it there too |
| Published but installs unchanged | Version not bumped | `pnpm bump <slug>`, republish, upgrade |
| Publish rejected: `Invalid secrets[].type` | Used `"string"` | Use `"secret"` |
| Publish rejected on schedules | Kebab-case name, wrong scope value, or dangling `tool` reference | snake_case; `per_install`/`platform`; tool must exist with a handler |
| `state.installId === 'unknown'` at the bouncer | Stale build without the INSTALL_ID binding | Upgrade the install to rebuild |
| Provider: redirect URI mismatch | Bouncer URL not registered (staging and prod are DIFFERENT URLs), or a stale flow | Register both; restart the flow fresh |
| Bouncer shows `expired_or_unknown_csrf` | Replayed/stale consent link, or two parallel starts | Restart from the settings page |
| Publish build fails to resolve an import that works locally | `workspace:*` dep or direct `packages/*` import | Vendor it: `sprigrVendor` + `pnpm sync:vendor` |
| `env.DB` undefined in a handler | Env rebuilt by spread | Plain property access; `Object.create(env)` to overlay |

---

## 11. Who does what

| Responsibility | Sprigr platform | Your app |
|---|---|---|
| Stable OAuth redirect URI + callback dispatch | bouncer | |
| Code exchange, refresh, token persistence | | kit `oauth-utils` + your four files |
| Token storage | allocates per-install D1 | writes via `d1-kv` stores |
| Secrets delivery | binds manifest `secrets[]` at build | declares them; seeds via `set-publisher-secrets` |
| Migrations | runs `migrations[]` after every build | authors them (immutable once published) |
| Scheduled fires | cron dispatcher | `schedules[]` + handler |
| Agent discovery of your tools | ingests `docs[]` into search | authors `docs[]` + tool descriptions |
| Build | build-runner on install/upgrade | `sprigr app publish` + version bump |

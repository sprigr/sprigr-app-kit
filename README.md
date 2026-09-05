# sprigr-app-kit

Everything you need to build, test, and publish a **Sprigr marketplace app**, including a complete OAuth connection to an external system.

Sprigr marketplace apps are Next.js apps that run isolated per install on the Sprigr platform, expose tools that Sprigr agents call, keep per-install state in their own D1 database, and connect to third-party systems via OAuth through Sprigr's shared bouncer.

## What's in the box

| Path | What it is |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | **New to Sprigr? Start here.** Zero-to-published setup: machine prereqs, account signup, CLI login, scaffold, provider OAuth registration, local testing, first publish. |
| [docs/build-guide.md](docs/build-guide.md) | Step-by-step app walkthrough: scaffold, manifest, OAuth, tools, publish. Written so an AI agent can follow it end to end. |
| [docs/marketplace-app-development.md](docs/marketplace-app-development.md) | End-to-end conceptual guide to the platform surface: manifest, runtime bindings, publish pipeline, OAuth bouncer, durable jobs + scoped store, vendoring vs npm. |
| [docs/platform-reference.md](docs/platform-reference.md) | Deep reference: manifest schema, runtime bindings (`env.SPRIGR.*`), publish pipeline, bouncer contract. |
| [docs/capability-cookbook.md](docs/capability-cookbook.md) | **The coverage index.** One row per capability family: manifest field → sample file → local-vs-staging → best production exemplar. When you need feature X, start here. |
| [docs/website-hosting.md](docs/website-hosting.md) | **Not building an app?** Host a website (static or Next.js) on Sprigr entirely from the CLI: create, deploy, env vars, custom domains, rollback. |
| [examples/harvest](examples/harvest) | A complete reference app: OAuth against Harvest (time tracking), token refresh, agent tools, AI-facing docs, tests. |
| [examples/showcase](examples/showcase) + [examples/showcase-consumer](examples/showcase-consumer) + [examples/static-badge](examples/static-badge) | Synthetic every-feature reference apps: `showcase` declares every manifest field and exercises every `env.SPRIGR.*` call; `showcase-consumer` shows the cross-app consumer side; `static-badge` is the minimal static-tier app. Indexed by the [capability cookbook](docs/capability-cookbook.md). |
| [packages/](packages) | The shared packages. All of them publish to npm as `@sprigr/apps-*`; exact-pin them. `app-sdk` (state codec, crypto, retrying fetch, platform types), `oauth-utils` (code exchange, race-safe refresh), `d1-kv` (token/settings stores), `sync-cursor`, `dedup-latch`, `fetch-budget` (per-attempt cap + shared call deadline under the platform's 110s dispatch wall), `undo-journal` (before-image store for the platform undo layer), `webhook-registry`, `faceted-search` (catalog search UI, [guide](docs/faceted-search.md)), `dashboard-kit` (admin dashboard design system), `timezone-picker` (IANA data + SSR `<TimezoneSelect>`). |
| [tools/](tools) | `create-app.mjs` (scaffolder), `sync-vendor.mjs` (vendoring + drift check), `bump-version.mjs`, `check-migrations-immutable.mjs`. |

## Quick start

```bash
pnpm install
pnpm create:app my-crm          # scaffold apps/my-crm with OAuth plumbing
pnpm install                    # register the new workspace package
# fill the printed TODOs (provider endpoints, manifest description, tools)
pnpm -F my-crm typecheck && pnpm -F my-crm test && pnpm -F my-crm build
pnpm verify:local               # vendor drift + migration immutability guards
sprigr app validate --dir apps/my-crm
sprigr app publish  --dir apps/my-crm
```

Then follow [docs/build-guide.md](docs/build-guide.md) from step 3 (provider facts) onward.

## Prerequisites

Full setup walkthrough: [docs/getting-started.md](docs/getting-started.md). In short:

- Node 20+ (>= 22.5 for `sprigr app dev`), pnpm.
- A Sprigr publisher account — sign up at https://team.sprigr.com/signup (onboarding creates your workspace) — and the CLI: `npm install -g @sprigr/cli`, then `sprigr login`.
- For OAuth apps: a developer-app registration with your provider, with the Sprigr bouncer redirect URI registered (`https://oauth-bouncer.sprigr.com/<slug>/oauth/callback`) plus `http://localhost:8666/<slug>/oauth/callback` on a dev OAuth app for local testing.

## The two rules that save you days

1. **Never edit a published migration file.** The platform ledgers each migration's hash per install; a one-byte change silently blocks every install from upgrading. New schema = new numbered migration file.
2. **Never `workspace:*`-import shared code into an app.** The platform build runs plain `npm install` with no monorepo context. Depend on the published `@sprigr/apps-*` packages at exact versions (the scaffolder does this). Every package in `packages/` is published, so the `sprigrVendor` source mirror is only a fallback for a package that cannot be.

Both are enforced by `pnpm verify:local`.

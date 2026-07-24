# sprigr-app-kit

Everything you need to build, test, and publish a **Sprigr marketplace app**, including a complete OAuth connection to an external system.

Sprigr marketplace apps are Next.js apps that run isolated per install on the Sprigr platform, expose tools that Sprigr agents call, keep per-install state in their own D1 database, and connect to third-party systems via OAuth through Sprigr's shared bouncer.

## What's in the box

| Path | What it is |
|---|---|
| [docs/build-guide.md](docs/build-guide.md) | **Start here.** Step-by-step: scaffold, manifest, OAuth, tools, publish. Written so an AI agent can follow it end to end. |
| [docs/platform-reference.md](docs/platform-reference.md) | Deep reference: manifest schema, runtime bindings (`env.SPRIGR.*`), publish pipeline, bouncer contract. |
| [examples/harvest](examples/harvest) | A complete reference app: OAuth against Harvest (time tracking), token refresh, agent tools, AI-facing docs, tests. |
| [packages/](packages) | The shared packages, published to npm as `@sprigr/apps-*` (exact-pin them): `oauth-utils` (code exchange, race-safe refresh), `app-sdk` (state codec, crypto, retrying fetch, platform types), `d1-kv` (token/settings stores), `sync-cursor`, `dedup-latch`, `webhook-registry`, `faceted-search` (catalog search UI, [guide](docs/faceted-search.md)). Unpublished, vendor-only: `dashboard-kit`, `timezone-picker`. |
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

- Node 20+, pnpm.
- A Sprigr publisher account and the CLI: `npm install -g @sprigr/cli`, then `sprigr login`.
- For OAuth apps: a developer-app registration with your provider, with both Sprigr bouncer redirect URIs registered (`https://oauth-bouncer.sprigr.com/<slug>/oauth/callback` and the `staging-oauth-bouncer` variant).

## The two rules that save you days

1. **Never edit a published migration file.** The platform ledgers each migration's hash per install; a one-byte change silently blocks every install from upgrading. New schema = new numbered migration file.
2. **Never `workspace:*`-import shared code into an app.** The platform build runs plain `npm install` with no monorepo context. Depend on the published `@sprigr/apps-*` packages at exact versions (the scaffolder does this); vendor only the unpublished UI packages.

Both are enforced by `pnpm verify:local`.

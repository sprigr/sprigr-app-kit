# Publishing the kit packages to npm (maintainers)

Every package under `packages/` publishes to npm, so apps (internal and external) can depend on them directly instead of vendoring:

| npm name | Notes |
|---|---|
| `@sprigr/apps-app-sdk` | |
| `@sprigr/apps-oauth-utils` | |
| `@sprigr/apps-d1-kv` | |
| `@sprigr/apps-sync-cursor` | |
| `@sprigr/apps-dedup-latch` | |
| `@sprigr/apps-fetch-budget` | |
| `@sprigr/apps-undo-journal` | |
| `@sprigr/apps-webhook-registry` | |
| `@sprigr/apps-faceted-search` | React; peer deps react/react-dom >= 18. Extra `./embed` entry. |
| `@sprigr/apps-dashboard-kit` | React; peer deps react/react-dom >= 18 and lucide-react. Ships CSS at `./styles` and needs Tailwind v4 plus an `@source` line in the consuming app. |
| `@sprigr/apps-timezone-picker` | React; peer dep react ^19. |

## Which packages publish

The `release` workflow **derives** the set: every directory under `packages/` whose `package.json` is not `"private": true`. There is no list to keep in sync, so a new package publishes as soon as it lands. To hold one back, put `"private": true` in that package's own `package.json` and the workflow skips it by name in the log.

This replaced a hardcoded loop that silently omitted any package nobody remembered to add, which is how `dashboard-kit` and `timezone-picker` went unpublished long after they were ready.

## One-time setup

1. Own the `sprigr` organization scope on npmjs.com.
2. Create an automation token with publish rights on that scope.
3. Add it as the `NPM_TOKEN` secret on the `sprigr/sprigr-app-kit` GitHub repo.

## Releasing

1. In a PR: bump the `version` in each changed package's `package.json` (semver; they version independently).
2. Merge to `main` (the `verify` workflow gates tests, builds, vendor drift, migration guard).
3. Run the `release` workflow (Actions tab, manual dispatch). It republishes nothing that is already on npm, so re-runs are safe.

Each package builds with `pnpm build` (tsup: single-file ESM + `.d.ts`); `prepublishOnly` rebuilds as a belt-and-braces guard for manual publishes. `dashboard-kit` chains a `copy-styles.mjs` step after tsup to place its stylesheets under `dist/styles/`, because the CSS ships verbatim rather than through the bundler.

## Rules for consumers (why exact pins)

Apps must pin **exact** versions (`"@sprigr/apps-oauth-utils": "0.1.0"`, no caret). The marketplace build-runner runs `npm install` per install build; a caret range would roll a new helper version into production installs with no app change, no version bump, and no review. Upgrading a helper is a deliberate app release: bump the pin, bump the app version, publish.

## Relationship to vendoring

npm is the mechanism; the `sprigrVendor` + `pnpm sync:vendor` source mirror is the fallback for a package that cannot be published. Nothing in `packages/` is in that position today, so a new app should reach for the npm dependency.

An app that predates a package's first publish keeps working off its `src/lib/vendor/` mirror until someone migrates it. The two mechanisms must not be mixed in one app: either the vendor mirror or the npm dependency, never both.

# Publishing the kit packages to npm (maintainers)

The six core packages publish to npm so apps (internal and external) can depend on them directly instead of vendoring:

`@sprigr/apps-app-sdk`, `@sprigr/apps-oauth-utils`, `@sprigr/apps-d1-kv`, `@sprigr/apps-sync-cursor`, `@sprigr/apps-dedup-latch`, `@sprigr/apps-webhook-registry`

(`dashboard-kit` and `timezone-picker` stay private/vendored for now: React + CSS packaging is a separate effort.)

## One-time setup

1. Own the `sprigr` organization scope on npmjs.com.
2. Create an automation token with publish rights on that scope.
3. Add it as the `NPM_TOKEN` secret on the `sprigr/sprigr-app-kit` GitHub repo.

## Releasing

1. In a PR: bump the `version` in each changed package's `package.json` (semver; they version independently).
2. Merge to `main` (the `verify` workflow gates tests, builds, vendor drift, migration guard).
3. Run the `release` workflow (Actions tab, manual dispatch). It republishes nothing that is already on npm, so re-runs are safe.

Each package builds with `pnpm build` (tsup: single-file ESM + `.d.ts`); `prepublishOnly` rebuilds as a belt-and-braces guard for manual publishes.

## Rules for consumers (why exact pins)

Apps must pin **exact** versions (`"@sprigr/apps-oauth-utils": "0.1.0"`, no caret). The marketplace build-runner runs `npm install` per install build; a caret range would roll a new helper version into production installs with no app change, no version bump, and no review. Upgrading a helper is a deliberate app release: bump the pin, bump the app version, publish.

## Relationship to vendoring

Until an app migrates to the npm packages it keeps using its `src/lib/vendor/` mirror (synced by `pnpm sync:vendor`). The two mechanisms must not be mixed in one app: either the vendor mirror or the npm dependency, never both.

# Vendored copy of `packages/d1-kv/`

This directory is **auto-generated** by `tools/sync-vendor.mjs` and
mirrored from `packages/d1-kv/src/` at the repo root.

**Do not edit files in here directly.** Edit the source under
`packages/d1-kv/src/` and run `pnpm sync:vendor` from the
repo root to re-mirror.

Why vendored: the marketplace build-runner installs each app's
`package.json` with npm in a fresh sandbox, with no monorepo
context. `workspace:*` resolutions break at publish time. The
vendor copy is the workaround.

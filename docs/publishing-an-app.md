# Publishing an app

This page covers everything between "my app works locally" and "companies are running it": logging in, the lockfile, validation, the publish itself, how a version rolls out to installs, secrets, visibility, upgrades and rollback, debugging, and what uninstall does to your app's data. For the manifest fields themselves see the [manifest reference](reference/manifest.md); for scopes and trust tiers see [scopes and trust](reference/scopes-and-trust.md).

(Releasing this kit's own `@sprigr/apps-*` npm packages is a different process, covered in [publishing.md](publishing.md).)

The whole loop, for an app at `apps/my-app`:

```bash
sprigr login                                   # once per machine and environment
pnpm lock:app apps/my-app                      # whenever dependencies change; commit the result
sprigr app validate --dir apps/my-app          # the platform's own manifest checks
sprigr app publish --dir apps/my-app --wait-fanout
```

For every later release, bump the version first (`pnpm bump my-app patch`).

## 1. Log in

```bash
npm install -g @sprigr/cli
sprigr login
sprigr whoami
```

`sprigr login` runs a device flow. It prints a URL and opens your browser. You approve the request in the portal while signed in, and the CLI stores a new API key in `~/.config/sprigr/credentials.json` with file mode 0600. The company you approved it from is your **publisher**: every app you publish with that key belongs to it.

**Endpoints.** The CLI talks to production (`https://api.team.sprigr.com`) unless told otherwise. It picks the endpoint in this order:

1. `--endpoint <url>` on the command;
2. the `SPRIGR_ENDPOINT` environment variable;
3. the endpoint saved by your last `sprigr login` for that profile;
4. production.

`--endpoint staging` and `--endpoint prod` are accepted as shorthands. Staging (`https://staging-api-team.sprigr.com`) is only useful if Sprigr has given you staging access.

**Profiles.** To stay logged in to more than one environment or company at once, use a profile:

```bash
sprigr login --profile staging --endpoint staging
sprigr app publish --dir apps/my-app --profile staging
```

Each profile keeps its own key and endpoint in `~/.config/sprigr/credentials/<profile>.json`. `SPRIGR_PROFILE` sets the profile for a whole shell. `sprigr whoami --all` lists the profiles you have.

**CI.** Set `SPRIGR_API_KEY` (or pass `--api-key`) and always pass `--endpoint` explicitly. A CI job with no endpoint and no credentials file publishes to production. Use `sprigr login --no-browser` on a machine with no browser; it prints the URL instead.

## 2. Write the lockfile

```bash
pnpm lock:app apps/my-app
git add apps/my-app/pnpm-lock.yaml apps/my-app/package.json
```

Publish refuses an app whose `package.json` has any dependencies and whose directory has no lockfile. The error code is `lockfile_required`. The platform builds every install from your source, and without a lockfile each build would resolve `package.json` afresh and could get a dependency tree nobody tested.

Apps in this kit share the workspace's root lockfile, which the platform never sees, so each app needs its own. `pnpm lock:app` resolves the app's `package.json` outside the workspace, with the pnpm version the build uses, writes `apps/<slug>/pnpm-lock.yaml`, and pins `packageManager` in the app's `package.json`. It refuses `workspace:`, `link:`, `file:` and `portal:` dependency specifiers, because the build cannot resolve them; depend on the published `@sprigr/apps-*` packages at exact versions instead.

**Re-run it after every dependency change.** The build installs strictly from the lockfile you ship (`pnpm install --frozen-lockfile`). If `package.json` and the lockfile disagree, the build fails; it does not fall back to a fresh resolve.

Only root files count: a `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock` at the top of the app directory. An app with no dependencies needs no lockfile.

## 3. Validate

```bash
sprigr app validate --dir apps/my-app
```

When you are logged in, validate sends your manifest to the platform's own validator and then checks the framework files on disk. Success prints `Manifest OK (live server check, not a publish guarantee)`. It is not a guarantee because publish runs further checks that need your files and your app's history: the lockfile, the file size caps, migration and docs files being present in the upload, the icon, and checks against earlier versions.

With no key, or when the server cannot be reached, validate falls back to a local subset and says so: `Manifest OK (offline, partial)`. The offline check does not cover everything the server checks. Treat an offline pass as a syntax check only.

The validator stops at the **first** error and reports only that one. Fix it and run again until it passes.

## 4. Publish

```bash
sprigr app publish --dir apps/my-app
```

The CLI reads `sprigr-app.json`, runs the local checks, bundles the directory as a map of path to file content, and sends it to the platform. The bundle skips `node_modules`, `.git`, `dist`, `.next`, `.turbo`, `__tests__` and anything listed in a `.sprigrignore` file in the app directory.

Limits:

- **500 files** per bundle (checked by the CLI).
- **5 MiB per file**, decoded.
- **5 MiB total**, decoded, across all files.
- **About 7.67 MiB on the wire**, which leaves room for base64 encoding of binary files. Over it, publish answers `Bundle exceeds 7.67MB wire cap`.

What the server does, in order:

1. Takes the publisher from the API key. App slugs are global: the first company to publish a slug owns it, and a publish of someone else's slug is refused with `Slug already taken by a different publisher`.
2. Validates the manifest, the icon, the migration and docs files, and the size caps.
3. Checks the lockfile (section 2).
4. Checks the version (section 6).
5. Stores the source and records the version as the app's current version. There is no per-version review step.
6. Queues an upgrade for every install that tracks the latest version (section 5).
7. Answers with the version, a summary of the queued upgrades, and any warnings, for example a legacy scope that grants nothing.

A first publish has no installs, so nothing is built until someone installs the app.

The CLI retries transient failures (HTTP 429, 502, 503, 504). If an earlier attempt landed before the failure, the retry gets a 409 and the CLI reports the version as published.

## 5. The rollout

A publish is a rollout, not a staging step. Test before you publish.

- **Tracking installs upgrade automatically.** Every install that tracks the latest version is moved to the new version and rebuilt. A new install tracks the latest version by default.
- **Pinned installs stay put.** An install whose owner pinned a version keeps it until they move it (section 9).
- **No install moves backwards.** An automatic upgrade never moves an install to a lower version.
- **A version is compiled once.** The first build of a version records its output, and every other install of that version reuses it with its own bindings, database and secrets.
- **Upgrades are queued.** The publish returns once the upgrades are queued, not when they are built. They normally run within a few minutes.
- **A reconciler fills the gaps.** Every 15 minutes the platform looks for tracking installs that are behind the current version or were left without a build, and queues them again. An install whose build of a version fails is retried up to twice more, at least an hour apart. After three failures it waits for your next publish or a manual upgrade.

To watch the rollout:

```bash
sprigr app publish --dir apps/my-app --wait-fanout=30m   # publish, then wait for every install's build
sprigr app rollout my-app 1.4.0                          # one snapshot: built, building, pending, failed, already newer
sprigr app rollout my-app 1.4.0 --wait=30m               # wait, as --wait-fanout does
```

Both waits exit non-zero if a build fails or the time runs out. The CLI prints `fan-out partial` or `fan-out threw` when installs were left behind, so a CI job can fail on those phrases. To rebuild every tracking install of the current version that was built before a given time, republish the same version with `--rebuild-installs-built-before <ISO time>`.

**The pin can lead the served code.** An install's version pin moves before its new build is deployed. For that short window, the install still runs the old code. A call to a tool that only the new version has answers `upgrade_pending` instead of running, until the new deployment is live; tools both versions share keep working on the old code. If the build fails, the pin moves back to the version actually being served.

## 6. Versioning rules

- `metadata.version` is the app's version, in `MAJOR.MINOR.PATCH` form. `sprigr_app.version` is the manifest format version and is a different field.
- **Each publish must be semver-greater than the app's current version.** Publish refuses a lower or equal version.
- Publishing a version that already exists answers 409 `Version <x> already exists for this app`. If that version is the current one, the 409 also re-queues upgrades for installs a previous publish left behind.
- `pnpm bump <slug> patch|minor|major` updates the version in the kit.
- **Never edit a published migration.** The platform records each applied migration with a hash of its SQL. If a later build carries the same file with different SQL, the build fails and the install keeps serving the previous version. Add a new migration file instead. Changes to comments and whitespace only are ignored.

## 7. Secrets

A manifest declares secrets in `secrets[]`. Each one becomes a binding on the install's worker, read as `env.<KEY>`. There are three kinds, depending on who supplies the value.

| Kind | Declared with | Who supplies the value | Scope |
|---|---|---|---|
| Install secret | (default) | The installing company, at install time | One install |
| Publisher secret | `publisher_provides: true` | You, the publisher, once per app | Every install of the app |
| Generated secret | `auto_generate: true` | The platform: 32 random bytes, base64 | One install, never shown to anyone |

**Install secrets.** The installer fills them in the portal's install dialog, passes them with `sprigr app install <slug> --scopes ... --secrets '{"KEY":"value"}'`, or passes `installSecrets` to the MCP `install_app` tool. A `required: true` secret with no value refuses the install with `Missing required secrets: <keys>`. The installer can change values later from the install's settings page or the MCP `configure_app_install` tool. `type: "secret"` hides the value in the portal; `type: "text"` shows it.

**Publisher secrets** are for credentials you own, such as your OAuth app's client id and secret:

```bash
sprigr app set-publisher-secrets my-app --secrets-file ./publisher-secrets.json
```

- Publish at least one version first; the command checks the keys against your current manifest. Every key must be declared with `publisher_provides: true`.
- Prefer `--secrets-file` over `--secrets '<json>'`, which puts the values on the command line where other processes can read them.
- The portal hides these fields from installers.
- If a required publisher secret has not been set, every install fails with `publisher_misconfigured`. Set them before you share or list the app.
- Setting a key that existing installs do not have yet adds it to them and rebuilds them.
- Rotating a key updates every install that took your value; an install whose owner supplied their own value keeps it. A running install picks up a rotated value at its next build.
- No API returns a stored value. To rotate, set a new one.

**Generated secrets** suit keys only your code reads, such as the key that encrypts provider tokens in the install's database. Each install gets its own value, minted once and never regenerated. The value cannot be recovered or moved, so anything encrypted under it is lost when the install is removed. `auto_generate` and `publisher_provides` cannot be combined. A value passed explicitly at install time wins over the generated one.

## 8. Who can see and install your app

A new app is **private**: only your own company sees it and can install it.

| You want | Do this | Result |
|---|---|---|
| Specific companies to install it | `sprigr app share my-app` (or the **Share** button on the app's page, or the MCP `share_app` tool) | Tier `shared`. Anyone with the share link can install it; it does not appear in other companies' marketplace. |
| Every company to find and install it | `POST /api/v1/data/apps/my-app/publish`, the MCP `publish_app_listing` tool, or the **List publicly** button | Tier `listed`. It appears in every company's marketplace. |
| The Certified badge | Ask Sprigr (platform@sprigr.com) for a review | Tier `certified`, granted by Sprigr only. |

`sprigr app share` prints the share URL. Running it again returns the same link; the API can replace it with `{"rotate": true}`, which breaks every link already sent. The MCP `unshare_app` tool revokes the link and returns a shared app to private. Existing installs keep working either way.

Listing is self-serve and has no review step. Any member, or any write-capable API key, of the publisher company can list the app:

```bash
curl -X POST "https://api.team.sprigr.com/api/v1/data/apps/my-app/publish" \
  -H "Authorization: Bearer $SPRIGR_API_KEY"
```

Set any required publisher secrets before you list. The tier is not a manifest field: publish refuses a manifest that sets `trust_tier`, and publishing a new version never changes the tier. [Scopes and trust](reference/scopes-and-trust.md) explains exactly what each tier changes.

## 9. Upgrades, pins and rollback

- **Pin an install.** The installing company's owner or admin can pin its install to a specific approved version: `PATCH /api/v1/data/apps/<slug>/install` with `{"pinned_version_id": "<version id>"}`. A pin turns off tracking, so later publishes leave that install alone, and it rebuilds the install on the pinned version. Sending `{"pinned_version_id": null}` turns tracking back on.
- **Upgrade a pinned install.** `sprigr app upgrade <slug>`, the portal's Upgrade banner, or the MCP `upgrade_app` tool moves your own company's install to the current version and rebuilds it. `--force` rebuilds even when the install is already on the current version, which is the recovery when an install is pinned to the right version but its build never deployed.
- **Roll back.** For one install, pin it to the earlier version. For every install, publish a new, higher version that contains the fix or the old code: installs never move to a lower version on their own.
- **Failed builds roll back by themselves.** When a build fails or times out, the install's pin returns to the version it is actually serving, and the previous deployment keeps running.
- **New scopes will need approval (decision 0328, in review, not yet implemented).** Today an upgrade grants a newly declared scope straight away. Under 0328, an upgrade that declares a scope the install has not granted ships the code but holds the scope until the installing company's owner or admin approves it. Until then, calls that need the scope answer 403 `scope_not_granted`. Handle that response. Details in [scopes and trust](reference/scopes-and-trust.md#scopes-on-upgrade).

## 10. Debugging a failed publish or build

Publish errors come back in the CLI output. Common ones:

| Message | Fix |
|---|---|
| `Manifest validation failed: <message>` | Only the first error is shown. Fix it and run `sprigr app validate` again. |
| `lockfile_required` | Run `pnpm lock:app apps/<slug>` and commit the lockfile. |
| `File "<path>" exceeds 5MB cap`, `Bundle exceeds 5MB total decoded cap`, `Bundle exceeds 7.67MB wire cap` | Remove build output and large assets; add a `.sprigrignore`. |
| `Too many files (<n>)` | Same: the limit is 500 files. |
| `Slug already taken by a different publisher` | Pick another slug, or check you are logged in as the right company (`sprigr whoami`). |
| `Version <x> already exists for this app` | Bump the version. |
| `Manifest references migration file "<file>" but it is not in the upload` | The file is missing or ignored. |
| `permissions.scopes: "<scope>" is not a platform scope` | See the scope list in [scopes and trust](reference/scopes-and-trust.md). |

A publish can succeed while builds fail. To find out why a build failed:

```bash
sprigr app rollout my-app 1.4.0          # each install's build id, state and error
sprigr site list --type app              # your own company's install sites
sprigr builds list <siteId>
sprigr builds get <siteId> <buildId>     # status, error summary, then the full build log
```

`sprigr builds` reads builds of your own company's installs. Common build failures:

- **Lockfile out of date.** The frozen install fails. Re-run `pnpm lock:app`.
- **A migration fails.** The build fails and the previous deployment keeps serving the old schema. An edited migration that has already been applied fails the same way (section 6).
- **An import cannot be resolved.** Usually a `workspace:` dependency or a direct import from `packages/`. Use the published npm package.

After a failed build the platform retries as section 5 describes. Once you have fixed the cause, publish a new version.

## 11. Designing for uninstall

Only an owner or admin of the installing company can uninstall. The platform then tears the install down in this order:

1. **Search indexes go first.** The app's search indexes for that company are deleted immediately, with no grace period.
2. **Your `on_uninstall` hook runs** while the worker, its D1 database and its secrets all still exist. It runs once, best effort, with a 15 second limit, and the uninstall continues whether it succeeds or not. Use it to release what only your app can see: revoke provider tokens, remove webhooks you registered with the provider, free a seat on a capped connection.
3. **Schedules, grants and workflows** the install created are removed.
4. **Secrets are deleted** immediately.
5. **Collections** the install defined are dropped. A collection defined with history is archived for 30 days first; if the same company reinstalls your app and defines the collection again, its history is restored. A collection without history is not kept.
6. **The install record** is deleted.
7. **The install's site** (worker, D1 database, KV and app files) is kept for 30 days and then deleted for good.

A reinstall is a new install with a new id and an empty database. Do not rely on the old D1 coming back. Provider tokens stored in that database stay on disk until the 30-day purge, which is another reason to revoke them in `on_uninstall`.

**Apps that hold business records.** If your app is the system of record for a company's data, declare `"data_lifecycle": { "system_of_record": true }` (see the [manifest reference](reference/manifest.md)). An uninstall of such an app then needs the owner's explicit waiver or an export first, an agent cannot uninstall it on its own, and the site's data is held past the normal purge. The flag is sticky: once any published version declared it, every install of the app is treated that way, even if a later version leaves it out.

## See also

- [Getting started](getting-started.md) and the [build guide](build-guide.md): building the app.
- [Manifest reference](reference/manifest.md): every manifest field.
- [Scopes and trust](reference/scopes-and-trust.md): what scopes unlock, and what each trust tier changes.
- [Marketplace app development](marketplace-app-development.md#lifecycle-hooks-on_install-on_upgrade-on_uninstall): the lifecycle hooks in detail.

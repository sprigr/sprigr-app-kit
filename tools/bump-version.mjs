#!/usr/bin/env node
/**
 * bump-version - bump an app's TWO version fields in lockstep.
 *
 * Publishing is gated on `metadata.version` in `apps/<slug>/sprigr-app.json`
 * (see .github/workflows/publish.yml): a source change without a version
 * bump silently never reaches installs. The app's `package.json` `version`
 * is supposed to track the manifest version, and keeping the two in sync
 * by hand is error-prone. This does both edits atomically.
 *
 * Usage:
 *   pnpm bump <slug> [patch|minor|major]     # default: patch
 *   pnpm bump <slug> --set 1.2.3             # explicit version
 *   pnpm bump <slug> --force-align           # resolve a pre-existing
 *                                            # mismatch (uses the manifest
 *                                            # version as truth), then bump
 *
 * Refuses to run when the two files already disagree, unless
 * --force-align is passed - a mismatch usually means a hand edit went
 * to only one file, and silently picking a side would hide that.
 *
 * Dependency-free (Node stdlib only), like the other tools/ scripts.
 * Edits preserve the file's existing JSON formatting by replacing only
 * the version string, so manifests keep their exact layout (important:
 * publish.yml diffs these files textually).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const SLUG = positional[0];
const BUMP = positional[1] ?? "patch";
const FORCE_ALIGN = args.includes("--force-align");
const setIdx = args.indexOf("--set");
const SET_VERSION = setIdx >= 0 ? args[setIdx + 1] : null;

function fail(msg) {
  console.error(`[bump-version] ERROR: ${msg}`);
  process.exit(1);
}

if (!SLUG) {
  console.error("Usage: pnpm bump <slug> [patch|minor|major] [--set X.Y.Z] [--force-align]");
  process.exit(1);
}
if (!SET_VERSION && !["patch", "minor", "major"].includes(BUMP)) {
  fail(`bump kind must be patch|minor|major (got "${BUMP}")`);
}

const APP_DIR = join(ROOT, "apps", SLUG);
const MANIFEST_PATH = join(APP_DIR, "sprigr-app.json");
const PKG_PATH = join(APP_DIR, "package.json");
if (!existsSync(MANIFEST_PATH)) fail(`apps/${SLUG}/sprigr-app.json not found`);
if (!existsSync(PKG_PATH)) fail(`apps/${SLUG}/package.json not found`);

const SEMVER = /^\d+\.\d+\.\d+$/;

const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
const pkgRaw = readFileSync(PKG_PATH, "utf8");
const manifestVersion = JSON.parse(manifestRaw).metadata?.version;
const pkgVersion = JSON.parse(pkgRaw).version;

if (!manifestVersion || !SEMVER.test(manifestVersion)) {
  fail(`manifest metadata.version "${manifestVersion}" is not plain semver`);
}
if (!pkgVersion || !SEMVER.test(pkgVersion)) {
  fail(`package.json version "${pkgVersion}" is not plain semver`);
}

if (manifestVersion !== pkgVersion && !FORCE_ALIGN) {
  fail(
    `version mismatch: sprigr-app.json has ${manifestVersion}, package.json has ${pkgVersion}.\n` +
      `  A previous edit updated only one file. Re-run with --force-align to\n` +
      `  treat the manifest version (${manifestVersion}) as truth and bump from there.`,
  );
}

function bump(version, kind) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const next = SET_VERSION ?? bump(manifestVersion, BUMP);
if (!SEMVER.test(next)) fail(`target version "${next}" is not plain semver`);

/**
 * Replace ONE version string in raw JSON text without reformatting the
 * file. Anchors on the exact `"version": "<old>"` token; verifies the
 * replacement changed exactly one occurrence by re-parsing.
 */
function replaceVersion(raw, path, oldV, newV, wantAtPath) {
  const token = `"version": "${oldV}"`;
  const count = raw.split(token).length - 1;
  if (count === 0) {
    fail(`could not find ${token} in ${path} (unexpected formatting)`);
  }
  // Replace only the first occurrence; then confirm the parse says the
  // right field moved. Manifests can contain other "version" keys
  // (sprigr_app.version, migrations[].version) but those hold different
  // values ("1", numbers), so the exact old-string anchor is safe unless
  // metadata.version coincides with another literal - the re-parse check
  // below catches that case.
  const updated = raw.replace(token, `"version": "${newV}"`);
  const got = wantAtPath(JSON.parse(updated));
  if (got !== newV) {
    fail(
      `replacing "${oldV}" in ${path} did not land on the intended field ` +
        `(got ${got}); edit the file manually`,
    );
  }
  return updated;
}

writeFileSync(
  MANIFEST_PATH,
  replaceVersion(manifestRaw, `apps/${SLUG}/sprigr-app.json`, manifestVersion, next, (j) => j.metadata?.version),
);
writeFileSync(
  PKG_PATH,
  replaceVersion(pkgRaw, `apps/${SLUG}/package.json`, pkgVersion, next, (j) => j.version),
);

console.log(`[bump-version] ${SLUG}: ${manifestVersion} → ${next}`);
if (manifestVersion !== pkgVersion) {
  console.log(`[bump-version] (aligned package.json from ${pkgVersion})`);
}
console.log(
  `[bump-version] both apps/${SLUG}/sprigr-app.json metadata.version and apps/${SLUG}/package.json version updated.`,
);

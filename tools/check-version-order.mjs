#!/usr/bin/env node
/**
 * check-version-order - refuse to publish a version lower than npm `latest`.
 *
 * release.yml publishes every unpublished version to the `latest` dist-tag,
 * so a lower version merged after a higher one would move `latest` backwards
 * (sprigr-app-kit#200).
 *
 * Usage: node tools/check-version-order.mjs <name> <version> <latest>
 * Exits 0 when <version> is newer than <latest> (or <latest> is empty),
 * 1 with a message otherwise. Dependency-free, like the other tools/ scripts.
 */
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a semver version: "${v}"`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a, b) {
  // A release outranks any prerelease of the same core version.
  if (a.length === 0 || b.length === 0) return (a.length === 0) - (b.length === 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1 as `a` is lower than, equal to or higher than `b`. */
export function compareSemver(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** null when publishing `version` as latest is fine, else the reason it is not. */
export function versionOrderError(name, version, latest) {
  if (!latest) return null;
  if (compareSemver(version, latest) > 0) return null;
  return (
    `${name}@${version} is not newer than npm latest ${latest}; publishing it would move latest backwards. ` +
    `Bump ${name} above ${latest} (a rebase may have kept an older version line).`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, version, latest = ""] = process.argv.slice(2);
  if (!name || !version) {
    console.error("Usage: node tools/check-version-order.mjs <name> <version> <latest>");
    process.exit(2);
  }
  const err = versionOrderError(name, version, latest.trim());
  if (err) {
    console.error(`[check-version-order] ERROR: ${err}`);
    process.exit(1);
  }
}

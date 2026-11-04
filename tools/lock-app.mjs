#!/usr/bin/env node
/**
 * lock-app: write the per-app pnpm-lock.yaml that `sprigr app publish` needs.
 *
 * The platform refuses to publish a version whose package.json has
 * dependencies but whose app dir ships no lockfile (`lockfile_required`), and
 * every install build runs `pnpm install --frozen-lockfile` against the one
 * you ship. Apps in this repo share the workspace's root lockfile, which the
 * platform never sees, so each app needs its own.
 *
 * This resolves the app's package.json in a copy outside the workspace, with
 * the pnpm the build-runner uses, writes <dir>/pnpm-lock.yaml and pins
 * <dir>/package.json `packageManager` to that pnpm. Re-run it whenever the
 * app's dependencies change, commit both files, and test against them.
 *
 * Run: pnpm lock:app <slug|dir>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Keep equal to the `corepack prepare pnpm@<v>` line in the build-runner image. */
const BUILD_PNPM_VERSION = '9.15.0';
const LOCAL_SPEC = /^(workspace|link|file|portal):/;

function resolveAppDir(arg) {
  for (const candidate of [arg, path.join('apps', arg), path.join('examples', arg)]) {
    if (existsSync(path.join(candidate, 'sprigr-app.json'))) return path.resolve(candidate);
  }
  throw new Error(`no sprigr-app.json at ${arg}, apps/${arg} or examples/${arg}`);
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: pnpm lock:app <slug|dir>');
    process.exit(2);
  }
  const appDir = resolveAppDir(arg);
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (LOCAL_SPEC.test(spec)) {
        throw new Error(`${section}.${name} is ${spec}: the build-runner cannot resolve a local specifier; pin a published version`);
      }
    }
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lock-app-'));
  try {
    cpSync(pkgPath, path.join(tmp, 'package.json'));
    const npmrc = path.join(appDir, '.npmrc');
    if (existsSync(npmrc)) cpSync(npmrc, path.join(tmp, '.npmrc'));
    execFileSync('npx', ['--yes', `pnpm@${BUILD_PNPM_VERSION}`, 'install', '--lockfile-only', '--ignore-workspace'], {
      cwd: tmp,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    cpSync(path.join(tmp, 'pnpm-lock.yaml'), path.join(appDir, 'pnpm-lock.yaml'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  pkg.packageManager = `pnpm@${BUILD_PNPM_VERSION}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), appDir)}/pnpm-lock.yaml and set packageManager to pnpm@${BUILD_PNPM_VERSION}.`);
  console.log('Commit both, then publish. Re-run after any dependency change.');
}

try {
  main();
} catch (err) {
  console.error(`lock-app: ${err.message}`);
  process.exit(1);
}

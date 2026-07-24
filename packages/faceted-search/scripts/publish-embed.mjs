#!/usr/bin/env node
/**
 * publish-embed - publish the standalone embed bundle to the Sprigr-hosted
 * embeds site.
 *
 * Why this exists: sprigr-apps is a PRIVATE repo, so agents cannot fetch
 * dist/facet-browse.js by raw GitHub URL. Instead the bundle is served from a
 * Sprigr-owned static site on the prod platform:
 *
 *   https://sprigr-hq-embeds.sites.sprigr.com/facet-browse/v1/facet-browse.js
 *
 * (site_j1ru3n1nwye98ycjorar, sprigr-hq tenant). This script codifies the
 * release step:
 *
 *   1. Verify dist/facet-browse.js is fresh (delegates to build-embed --check).
 *   2. Assemble a temp static-site dir:
 *        index.html                        directory page: embeds + version + sha256
 *        facet-browse/v1/facet-browse.js   the committed bundle
 *   3. Start a static build on the embeds site via the platform HTTP API
 *      (POST /api/v1/data/websites/:siteId/builds, the same start-build + poll
 *      flow the sprigr-team CLI's `sprigr deploy` uses) and poll to a terminal
 *      status.
 *
 * Usage (operator release tool):
 *
 *   pnpm --filter @sprigr/apps-faceted-search publish:embed -- --profile prod
 *   SPRIGR_API_KEY=sk_mcp_... pnpm --filter @sprigr/apps-faceted-search publish:embed
 *
 * Credentials, in priority order:
 *   --profile <name>       reads ~/.config/sprigr/credentials/<name>.json
 *                          (fields: apiKey, endpoint) as written by `sprigr login`
 *   SPRIGR_API_KEY         bearer key; SPRIGR_ENDPOINT overrides the API base
 *                          (defaults to https://api.team.sprigr.com)
 * Site id: SPRIGR_EMBEDS_SITE_ID overrides the default embeds site.
 *
 * NOT wired into CI on purpose: CI has no platform credentials. This is a
 * manual operator step, run after a deliberate embed release (see the README's
 * "Releasing the hosted embed" section for the v1/v2 path policy).
 *
 * Dependency-free (Node stdlib + global fetch), like tools/sync-vendor.mjs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_FILE = join(PKG_ROOT, 'dist', 'facet-browse.js');
const DEFAULT_SITE_ID = 'site_j1ru3n1nwye98ycjorar'; // sprigr-hq-embeds (prod)
const DEFAULT_ENDPOINT = 'https://api.team.sprigr.com';
const HOSTED_BASE = 'https://sprigr-hq-embeds.sites.sprigr.com';

const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const PROFILE = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
const KEEP_DIR = args.includes('--keep-dir');
const DRY_RUN = args.includes('--dry-run');

function fail(msg) {
  console.error(`[publish-embed] ERROR: ${msg}`);
  process.exit(1);
}

// ── Credentials ──────────────────────────────────────────────────────
function resolveCreds() {
  if (PROFILE) {
    if (!/^[A-Za-z0-9_-]+$/.test(PROFILE)) fail(`invalid profile name: ${PROFILE}`);
    const file = join(process.env.HOME ?? '', '.config', 'sprigr', 'credentials', `${PROFILE}.json`);
    if (!existsSync(file)) fail(`profile file not found: ${file}`);
    let creds;
    try {
      creds = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`could not parse ${file}: ${err.message}`);
    }
    if (!creds.apiKey) fail(`profile ${PROFILE} has no apiKey`);
    return { apiKey: creds.apiKey, endpoint: (creds.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '') };
  }
  const apiKey = process.env.SPRIGR_API_KEY;
  if (!apiKey) fail('no credentials: pass --profile <name> or set SPRIGR_API_KEY');
  const endpoint = (process.env.SPRIGR_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  return { apiKey, endpoint };
}

// ── 1. Freshness gate ────────────────────────────────────────────────
// Never publish a stale bundle: delegate to the same check CI runs.
console.log('[publish-embed] verifying dist/facet-browse.js is fresh ...');
const check = spawnSync(process.execPath, [join(PKG_ROOT, 'scripts', 'build-embed.mjs'), '--check'], {
  stdio: 'inherit',
});
if (check.status !== 0) {
  fail('dist/facet-browse.js is stale. Run build:embed, commit the result, then publish.');
}

// ── 2. Assemble the static site dir ──────────────────────────────────
const bundle = readFileSync(DIST_FILE, 'utf8');
const sha256 = createHash('sha256').update(bundle).digest('hex');
const pkgVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
const publishedAt = new Date().toISOString();

const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sprigr embeds</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; color: #171c16; }
  code { background: #f2f1ec; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e4e3dc; font-size: 14px; vertical-align: top; }
  .sha { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; color: #6c7268; }
</style>
</head>
<body>
<h1>Sprigr embeds</h1>
<p>Self-contained UI bundles for agent-built static websites. Fetch a file and
inline it, or reference it by URL.</p>
<table>
  <tr><th>Embed</th><th>Version</th><th>URL</th></tr>
  <tr>
    <td>facet-browse<div class="sha">sha256 ${sha256}</div></td>
    <td>${pkgVersion}<div class="sha">published ${publishedAt}</div></td>
    <td><a href="/facet-browse/v1/facet-browse.js"><code>/facet-browse/v1/facet-browse.js</code></a></td>
  </tr>
</table>
<p>Source: <code>sprigr-apps/packages/faceted-search</code> (private repo).
The <code>v1</code> path is updated in place for compatible changes; a breaking
config change ships under <code>/facet-browse/v2/</code>.</p>
</body>
</html>
`;

const siteDir = mkdtempSync(join(tmpdir(), 'sprigr-embeds-'));
mkdirSync(join(siteDir, 'facet-browse', 'v1'), { recursive: true });
writeFileSync(join(siteDir, 'index.html'), indexHtml);
writeFileSync(join(siteDir, 'facet-browse', 'v1', 'facet-browse.js'), bundle);
console.log(`[publish-embed] assembled site dir: ${siteDir}`);
console.log(`[publish-embed]   facet-browse v${pkgVersion} sha256=${sha256.slice(0, 16)}...`);

// Walk the dir into the { path: content } files map the build API expects.
// All embed files are UTF-8 text, so no base64 branch is needed here.
function collectFiles(root) {
  const files = {};
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  }
  walk(root);
  return files;
}
const files = collectFiles(siteDir);

function cleanup() {
  if (KEEP_DIR) console.log(`[publish-embed] keeping site dir (--keep-dir): ${siteDir}`);
  else rmSync(siteDir, { recursive: true, force: true });
}

if (DRY_RUN) {
  console.log(`[publish-embed] dry run: would upload ${Object.keys(files).length} files:`);
  for (const f of Object.keys(files).sort()) console.log(`  ${f}`);
  cleanup();
  process.exit(0);
}

// ── 3. Deploy: start-build + poll (the `sprigr deploy` flow) ─────────
const siteId = process.env.SPRIGR_EMBEDS_SITE_ID ?? DEFAULT_SITE_ID;
const { apiKey, endpoint } = resolveCreds();

async function api(method, path, body) {
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text.length > 0 ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && (parsed.message ?? parsed.error)
      ? (parsed.message ?? parsed.error)
      : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }
  return parsed;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

try {
  console.log(`[publish-embed] starting static build on ${siteId} via ${endpoint} ...`);
  const start = await api('POST', `/api/v1/data/websites/${encodeURIComponent(siteId)}/builds`, {
    files,
    framework: 'static',
    source: 'cli',
  });
  const buildId = start.buildId;
  console.log(`[publish-embed]   build ${buildId} (status=${start.status})`);

  const deadline = Date.now() + 10 * 60_000; // static builds are fast; 10 min is generous
  let lastStatus = null;
  let build = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      ({ build } = await api('GET', `/api/v1/data/websites/${encodeURIComponent(siteId)}/builds/${encodeURIComponent(buildId)}`));
    } catch (err) {
      console.log(`[publish-embed]   poll failed (${err.message}), retrying ...`);
      continue;
    }
    if (build.status !== lastStatus) {
      console.log(`[publish-embed]   status: ${build.status}`);
      lastStatus = build.status;
    }
    if (TERMINAL.has(build.status)) break;
  }

  if (!build || !TERMINAL.has(build.status)) {
    fail(`build ${buildId} did not reach a terminal status in time`);
  }
  if (build.status !== 'succeeded') {
    fail(`build ${buildId} ${build.status}${build.errorSummary ? `: ${build.errorSummary}` : ''}`);
  }

  console.log(`[publish-embed] published. Verify:`);
  console.log(`[publish-embed]   ${HOSTED_BASE}/facet-browse/v1/facet-browse.js`);
  console.log(`[publish-embed]   expected sha256: ${sha256}`);
} finally {
  cleanup();
}

#!/usr/bin/env node
/**
 * Capability-coverage guard.
 *
 * docs/capability-cookbook.md promises that every marketplace capability has a
 * worked sample. That promise rots silently: the platform grows a method or a
 * manifest field, nobody notices the kit never demonstrated it, and the next
 * developer concludes the capability doesn't exist. This makes the promise
 * testable instead.
 *
 * Two checks:
 *   1. every env.SPRIGR method below is called by some file under examples/
 *   2. every AppManifest field below is declared by some example manifest
 *
 * The two lists are transcribed from the platform (the wrapper's SPRIGR object
 * and the AppManifest interface). When the platform adds a capability, add it
 * here in the same change — this script failing is the intended way to find out
 * the kit owes a sample.
 *
 * Run: node tools/check-capability-coverage.mjs   (wired into `pnpm verify:local`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/** env.SPRIGR surface: group -> methods. '' is the top level (env.SPRIGR.emit). */
const SPRIGR_METHODS = {
  '': ['emit', 'invoke', 'registerChannel', 'registerWebhookTenant', 'run_workflow'],
  browser: ['fetch', 'screenshot', 'session'],
  collections: ['define', 'describe', 'history', 'ingest', 'ingestFromTable', 'query', 'reconcile'],
  data: ['get', 'import', 'search'],
  files: ['putStream', 'url'],
  fulfillment_services: ['delete', 'list', 'register', 'update'],
  inbox: ['append'],
  integrations: ['invoke'],
  jobs: ['cancel', 'get', 'list', 'signal', 'start'],
  schedules: ['create'],
  store: ['delete', 'get', 'list', 'put'],
  usage: ['report'],
};

/**
 * AppManifest fields that a sample must declare. `auth` is deliberately
 * excluded: it survives in the platform's types but has no server-side
 * consumer (nothing reads manifest.auth), so demonstrating it would teach a
 * dead pattern. See the cookbook's Completeness section.
 */
const MANIFEST_FIELDS = [
  'sprigr_app', 'metadata', 'kind', 'runtime', 'permissions', 'oauth', 'lifecycle',
  'tool_access', 'content_restrictions', 'config_schema', 'data_index', 'agent_config',
  'training_index', 'tools', 'cross_tenant_tools', 'app_dependencies',
  'integration_dependencies', 'fulfillment_services', 'migrations', 'docs', 'secrets',
  'webhooks', 'channels', 'schedules', 'jobs', 'agent_schedules', 'events',
  'workflow_templates', 'decision_points', 'dependencies',
];

const EXAMPLES = 'examples';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.sprigr') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(EXAMPLES);
const source = files
  .filter((f) => ['.ts', '.tsx'].includes(extname(f)))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const manifests = files
  .filter((f) => f.endsWith('sprigr-app.json'))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(f, 'utf8')) }));

const missingMethods = [];
for (const [group, methods] of Object.entries(SPRIGR_METHODS)) {
  for (const m of methods) {
    const needle = group ? `SPRIGR.${group}.${m}` : `SPRIGR.${m}`;
    if (!source.includes(needle)) missingMethods.push(needle);
  }
}

const declared = new Set(manifests.flatMap(({ json }) => Object.keys(json)));
const missingFields = MANIFEST_FIELDS.filter((f) => !declared.has(f));

const methodCount = Object.values(SPRIGR_METHODS).reduce((n, m) => n + m.length, 0);

if (missingMethods.length || missingFields.length) {
  if (missingMethods.length) {
    console.error(
      `\nenv.SPRIGR methods with no sample (${missingMethods.length}/${methodCount}):`,
    );
    for (const m of missingMethods) console.error(`  env.${m}`);
  }
  if (missingFields.length) {
    console.error(`\nAppManifest fields no example declares (${missingFields.length}):`);
    for (const f of missingFields) console.error(`  ${f}`);
  }
  console.error(
    '\nAdd a sample that exercises each, or — if the platform dropped the capability —' +
      '\nremove it from tools/check-capability-coverage.mjs and from docs/capability-cookbook.md.\n',
  );
  process.exit(1);
}

console.log(
  `OK: all ${methodCount} env.SPRIGR methods and ${MANIFEST_FIELDS.length} manifest fields ` +
    `have a sample across ${manifests.length} example manifests.`,
);

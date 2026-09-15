/**
 * The scaffold templates and this harness read the same contract from two
 * places: `tools/templates/fulfilment-adapter.mjs` builds the manifest and
 * the handlers, `src/contract.ts` checks them. Two transcriptions of one
 * contract drift, and the drift is invisible: a freshly scaffolded app keeps
 * passing its own generated test while claiming an op the hub does not
 * dispatch, or missing one it does.
 *
 * So this scaffolds both templates for real and runs both halves of the
 * harness over the result.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkAdapterManifest } from '../src/manifest';
import { runFulfilmentProviderConformance } from '../src/fulfilment-provider';
import { runOrderSourceConformance } from '../src/order-source';
import { formatReport } from '../src/report';
import type { AdapterHandlers } from '../src/types';

const PKG_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const CREATE_APP = join(REPO_ROOT, 'tools', 'create-app.mjs');

// Inside the package, not /tmp: vitest only transforms files under the
// workspace root, and the generated handlers have to be imported for real.
const OUT = mkdtempSync(join(PKG_ROOT, '.scaffold-'));

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function scaffold(slug: string, template: string): string {
  execFileSync(process.execPath, [CREATE_APP, slug, '--template', template, '--out-dir', OUT], {
    stdio: 'pipe',
  });
  return join(OUT, slug);
}

function manifestOf(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'sprigr-app.json'), 'utf8'));
}

function failed(report: { checks: { name: string; ok: boolean }[] }): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('pnpm create:app --template fulfilment-provider', () => {
  const dir = scaffold('scaffold-wh', 'fulfilment-provider');

  it('generates a manifest that passes every manifest check', () => {
    const report = checkAdapterManifest(manifestOf(dir), 'fulfilment_provider');
    expect(failed(report), formatReport(report)).toEqual([]);
  });

  it('generates handlers that pass the whole runtime suite', async () => {
    const mod = (await import(join(dir, 'src', 'handlers', 'scaffold-wh-provider.ts'))) as {
      default: AdapterHandlers;
    };
    const deps = (await import(join(dir, 'src', 'lib', 'deps.ts'))) as {
      depsFor: (env: unknown) => { vendor: { calls: number } };
    };
    const env = {};
    const report = await runFulfilmentProviderConformance(mod.default, {
      slug: 'scaffold-wh',
      env: () => env,
      vendorCalls: () => deps.depsFor(env).vendor.calls,
      fixtures: { push_order: { warehouse_key: 'main' }, get_stock: { skus: ['TODO-SKU-1'] } },
    });
    expect(failed(report), formatReport(report)).toEqual([]);
  });
});

describe('pnpm create:app --template order-source', () => {
  const dir = scaffold('scaffold-src', 'order-source');

  it('generates a manifest that passes every manifest check', () => {
    const report = checkAdapterManifest(manifestOf(dir), 'order_source');
    expect(failed(report), formatReport(report)).toEqual([]);
  });

  it('generates handlers that pass the whole runtime suite', async () => {
    const mod = (await import(join(dir, 'src', 'handlers', 'scaffold-src-order-source.ts'))) as {
      default: AdapterHandlers;
    };
    const store = (await import(join(dir, 'src', 'lib', 'store.ts'))) as {
      FIXTURE_ORDER: { source_ref: string };
    };
    const report = await runOrderSourceConformance(mod.default, {
      slug: 'scaffold-src',
      env: () => ({}),
      fixtures: { get_order: { source_ref: store.FIXTURE_ORDER.source_ref } },
    });
    expect(failed(report), formatReport(report)).toEqual([]);
  });
});

describe('the default template', () => {
  it('still scaffolds the historical starter, untouched by the adapter templates', () => {
    const dir = scaffold('scaffold-plain', 'default');
    const manifest = manifestOf(dir) as { kind: string; tools: { name: string }[] };
    expect(manifest.kind).toBe('integration');
    expect(manifest.tools.map((t) => t.name)).toEqual([
      'scaffold_plain_tool',
      'scaffold_plain_oauth_callback',
    ]);
    expect(readFileSync(join(dir, '__tests__', 'smoke.test.ts'), 'utf8')).toContain('runTool');
  });
});

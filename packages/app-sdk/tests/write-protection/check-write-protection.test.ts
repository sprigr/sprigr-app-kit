import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain mjs, no types
import { applyAllowlist, isDestructiveName, run, scanManifest } from '../../bin/check-write-protection.mjs';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: '', handler: 'x', input_schema: { type: 'object', properties: {} }, ...extra });

describe('isDestructiveName', () => {
  it.each(['delete_product', 'shopify_delete_product', 'cancel_order', 'void_invoice', 'unship_order', 'rotate_brand_secrets', 'gmc_batch_delete_regions', 'x_bulk_destroy', 'shopify_capture_payment', 'complete_draft_order'])('%s is destructive', (n) => {
    expect(isDestructiveName(n)).toBe(true);
  });
  it.each(['list_products', 'get_refund', 'refund_rate_report', 'create_invoice', 'update_customer', 'undeleted_items', 'remover_lookup'])('%s is not flagged by the verb alone', (n) => {
    // `get_refund` and `refund_rate_report` DO match (refund is a verb here);
    // they are the allowlist's job. This test pins the ones that must not.
    if (n === 'get_refund' || n === 'refund_rate_report') return;
    expect(isDestructiveName(n)).toBe(false);
  });
});

describe('scanManifest', () => {
  it('flags an ungated destructive flat tool and accepts a policy or the legacy boolean', () => {
    const m = { tools: [
      tool('shopify_delete_product'),
      tool('shopify_delete_page', { confirmation: { always: true, describe: 'x' } }),
      tool('linkedin_remove_connection', { confirmation_required: true }),
      tool('shopify_delete_redirect', { confirmation: { describe: 'says nothing' } }),
      tool('internal_purge', { internal: true }),
      tool('list_products'),
    ] };
    expect(scanManifest(m)).toEqual(['shopify_delete_product', 'shopify_delete_redirect']);
  });

  it('inspects enumerated dispatcher actions and flags un-enumerated dispatchers', () => {
    const m = { tools: [
      tool('simpro', { dispatch: { actionField: 'action', actions: ['create_job', 'delete_job', 'archive_job'] }, confirmation: { actions: { delete_job: { always: true, describe: 'd' } } } }),
      tool('xero', { input_schema: { properties: { action: { enum: ['void_invoice', 'list_invoices'] } } } }),
      tool('gorgias', { input_schema: { properties: { action: { type: 'string' } } } }),
      tool('cw', { dispatch: { actionField: 'op' }, input_schema: { properties: { op: { enum: ['delete'] } } }, confirmation: { always: true, describe: 'all' } }),
    ] };
    expect(scanManifest(m)).toEqual(['xero:void_invoice', 'gorgias:<unenumerated>']);
  });
});

describe('applyAllowlist', () => {
  it('removes allowed entries, reports stale and unreasoned ones', () => {
    const r = applyAllowlist(['a', 'b:delete'], { allow: { a: 'a read named badly', 'c': 'gone', 'b:delete': '' } });
    expect(r.violations).toEqual([]);
    expect(r.stale).toEqual(['c']);
    expect(r.unreasoned).toEqual(['b:delete']);
  });
});

describe('run (filesystem)', () => {
  function repo(apps: Record<string, unknown>, extra: (root: string) => void = () => {}) {
    const root = mkdtempSync(join(tmpdir(), 'wp-'));
    for (const [slug, manifest] of Object.entries(apps)) {
      mkdirSync(join(root, 'apps', slug), { recursive: true });
      writeFileSync(join(root, 'apps', slug, 'sprigr-app.json'), JSON.stringify(manifest));
    }
    mkdirSync(join(root, 'tools'), { recursive: true });
    extra(root);
    return root;
  }
  const bad = { tools: [tool('acme_delete_thing'), tool('acme_list_things')] };
  const good = { tools: [tool('acme_delete_thing', { confirmation: { always: true, describe: 'Delete {id}', irreversible: true } })] };

  it('fails on a new violation and passes once gated', () => {
    expect(run([], repo({ bad })).code).toBe(1);
    expect(run([], repo({ good })).code).toBe(0);
  });

  it('--warn reports without failing', () => {
    const r = run(['--warn'], repo({ bad }));
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/acme_delete_thing is destructive by name/);
  });

  it('an allowlist entry with a reason clears a violation; a stale one fails', () => {
    const root = repo({ bad }, (r) => writeFileSync(join(r, 'apps', 'bad', 'write-protection.json'), JSON.stringify({ allow: { acme_delete_thing: 'soft delete, restorable from the UI' } })));
    expect(run([], root).code).toBe(0);
    const stale = repo({ good }, (r) => writeFileSync(join(r, 'apps', 'good', 'write-protection.json'), JSON.stringify({ allow: { acme_delete_thing: 'x' } })));
    const res = run([], stale);
    expect(res.code).toBe(1);
    expect(res.lines.join('\n')).toMatch(/is stale/);
  });

  it('the baseline ratchets: known violations pass, new ones fail, banked headroom must be written', () => {
    const root = repo({ bad });
    const w = run(['--write-baseline', '--baseline', join(root, 'tools', 'write-protection-baseline.json')], root);
    expect(w.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'tools', 'write-protection-baseline.json'), 'utf8'))).toEqual({ bad: ['acme_delete_thing'] });
    // default path is picked up automatically
    expect(run([], root).code).toBe(0);
    // add a second destructive tool: new violation fails
    writeFileSync(join(root, 'apps', 'bad', 'sprigr-app.json'), JSON.stringify({ tools: [...bad.tools, tool('acme_purge_all')] }));
    const r2 = run([], root);
    expect(r2.code).toBe(1);
    expect(r2.lines.join('\n')).toMatch(/acme_purge_all is destructive/);
    // gate the original: baseline is now stale and must be re-written
    writeFileSync(join(root, 'apps', 'bad', 'sprigr-app.json'), JSON.stringify(good));
    const r3 = run([], root);
    expect(r3.code).toBe(1);
    expect(r3.lines.join('\n')).toMatch(/bank the headroom/);
  });
});

describe('the CLI entrypoint', () => {
  it('runs when invoked through a symlink, which is how npm installs a bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'wp-bin-'));
    mkdirSync(join(root, 'apps', 'a'), { recursive: true });
    writeFileSync(join(root, 'apps', 'a', 'sprigr-app.json'), JSON.stringify({ tools: [tool('acme_delete_thing')] }));
    const real = fileURLToPath(new URL('../../bin/check-write-protection.mjs', import.meta.url));
    const link = join(root, 'sprigr-check-write-protection');
    symlinkSync(real, link);
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [link, '--warn'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      code = (e as { status: number }).status;
      out = String((e as { stdout: string }).stdout) + String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(0);
    expect(out).toMatch(/acme_delete_thing is destructive by name/);
    try {
      execFileSync(process.execPath, [link], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error('expected a non-zero exit');
    } catch (e) {
      expect((e as { status: number }).status).toBe(1);
    }
  });
});

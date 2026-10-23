/**
 * `pnpm create:app` scaffolds a WRITE tool's idempotency declaration and the
 * idempotent-write dedup handler TOGETHER, so an app author never adds the
 * write dispatch tier without the dedup that makes its retry safe
 * (sprigr-team decisions 0260 and 0294).
 *
 * A JSON manifest cannot carry a commented declaration, so the author-facing
 * pairing guidance lives in the generated tool handler (emitted .ts, with
 * comments) and the `<app>_write_keys` claims table is pre-created in the init
 * migration — not actively declared on the tool, because the scaffolder does
 * not know whether the tool is a read or a write and must not force the write
 * tier (and a pointless `_write_key`) onto a read.
 *
 * Content assertions only: this reads the generated files, it does not import
 * or run them, so it needs no scaffolded-app dependencies.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PKG_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const CREATE_APP = join(REPO_ROOT, 'tools', 'create-app.mjs');

const OUT = mkdtempSync(join(PKG_ROOT, '.scaffold-idem-'));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function scaffoldDefault(slug: string): string {
  execFileSync(process.execPath, [CREATE_APP, slug, '--out-dir', OUT], { stdio: 'pipe' });
  return join(OUT, slug);
}

describe('pnpm create:app scaffolds idempotent-write wiring for write tools', () => {
  const dir = scaffoldDefault('scaffold-idem');
  const handler = readFileSync(join(dir, 'src/handlers/scaffold-idem-tool.ts'), 'utf8');
  const migration = readFileSync(join(dir, 'migrations/0001_init.sql'), 'utf8');

  it('the tool handler carries the dedup wiring paired with the manifest declaration', () => {
    // The two manifest fields are named together, as a pair.
    expect(handler).toContain('effects: "write"');
    expect(handler).toContain('idempotency: { mode: "request" }');
    // The dedup helper, keyed on the platform-forwarded write key, against the
    // app's own claims table.
    expect(handler).toContain("makeIdempotentWrite({ db: env.DB, table: 'scaffold_idem_write_keys' })");
    expect(handler).toContain('idempotentToolResult(outcome)');
    expect(handler).toContain("from '@sprigr/apps-dedup-latch'");
    // The arg the platform forwards only when idempotency is declared.
    expect(handler).toContain('_write_key');
  });

  it('the init migration pre-creates the <app>_write_keys claims table', () => {
    expect(migration).toContain('CREATE TABLE scaffold_idem_write_keys');
    for (const col of ['id', 'state', 'result', 'claimed_at', 'expires_at']) {
      expect(migration).toContain(col);
    }
  });

  it('still generates a valid manifest', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'sprigr-app.json'), 'utf8')) as {
      migrations: { file: string }[];
    };
    expect(manifest.migrations.some((m) => m.file === 'migrations/0001_init.sql')).toBe(true);
  });
});

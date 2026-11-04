/**
 * Every secret the scaffolder tells you to seed with `sprigr app
 * set-publisher-secrets` must be declared `publisher_provides: true`. The
 * platform's publisher-secrets route refuses any other key with a 400, and
 * without the flag the install dialog asks every tenant for the publisher's
 * OAuth client secret.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CREATE_APP = join(REPO_ROOT, 'tools', 'create-app.mjs');
const OUT = mkdtempSync(join(tmpdir(), 'sprigr-scaffold-pubsecrets-'));

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

interface SecretDeclaration {
  key: string;
  publisher_provides?: boolean;
  auto_generate?: boolean;
}

describe('pnpm create:app (default template, OAuth): publisher secrets', () => {
  const stdout = execFileSync(process.execPath, [CREATE_APP, 'pub-secrets', '--out-dir', OUT], { encoding: 'utf8' });
  const manifest = JSON.parse(readFileSync(join(OUT, 'pub-secrets', 'sprigr-app.json'), 'utf8')) as {
    secrets: SecretDeclaration[];
  };

  it('declares every key in the printed set-publisher-secrets command as publisher_provides', () => {
    const command = stdout.slice(stdout.indexOf('set-publisher-secrets'));
    const seeded = [...command.matchAll(/"([A-Z][A-Z0-9_]*)":/g)].map((m) => m[1]);
    expect(seeded).toEqual(['PUB_SECRETS_CLIENT_ID', 'PUB_SECRETS_CLIENT_SECRET']);
    for (const key of seeded) {
      const declared = manifest.secrets.find((s) => s.key === key);
      expect(declared, key).toBeDefined();
      expect(declared?.publisher_provides, key).toBe(true);
      expect(declared?.auto_generate, key).toBeUndefined();
    }
  });
});

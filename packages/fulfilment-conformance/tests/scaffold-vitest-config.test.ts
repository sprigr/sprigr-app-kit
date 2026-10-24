/**
 * sprigr-apps#3821: `pnpm create:app` in sprigr-apps runs this scaffolder and
 * wrote `apps/<slug>/vitest.config.ts` as a bare `defineConfig({...})`. That
 * repo requires every app config to inherit its `vitest.shared.ts` (the
 * repo-wide 30 s timeouts; tools/check-vitest-shared.mjs), so a bare config
 * runs on vitest's 5 s default and fails the check once the app is tracked.
 * sprigr-works merged that way (#3819).
 *
 * The scaffolder now writes the `mergeConfig(baseConfig, ...)` form when the
 * repo it writes into has a `vitest.shared` two levels above the app (the
 * `<repo>/apps/<slug>` layout), and keeps the bare form anywhere else, so a
 * standalone scaffold does not import a file that is not there.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG_ROOT = join(__dirname, '..');
const CREATE_APP = join(PKG_ROOT, '..', '..', 'tools', 'create-app.mjs');
const TMP = mkdtempSync(join(PKG_ROOT, '.scaffold-vitest-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function scaffold(appsDir: string, slug: string): string {
  execFileSync(process.execPath, [CREATE_APP, slug, '--out-dir', appsDir], { stdio: 'pipe' });
  return readFileSync(join(appsDir, slug, 'vitest.config.ts'), 'utf8');
}

describe('create:app vitest.config.ts (sprigr-apps#3821)', () => {
  it('inherits the repo vitest.shared when the target repo has one', () => {
    const repo = join(TMP, 'monorepo');
    mkdirSync(join(repo, 'apps'), { recursive: true });
    writeFileSync(join(repo, 'vitest.shared.ts'), 'export const baseConfig = {};\n');
    const cfg = scaffold(join(repo, 'apps'), 'zz-shared');
    // What sprigr-apps' tools/check-vitest-shared.mjs asserts, textually.
    expect(cfg).toContain('vitest.shared');
    expect(cfg).toContain("import { baseConfig } from '../../vitest.shared';");
    expect(cfg).toMatch(/export default mergeConfig\(\s*baseConfig,\s*defineConfig\(/);
    expect(existsSync(join(repo, 'apps', 'zz-shared', '..', '..', 'vitest.shared.ts'))).toBe(true);
    // The app's own settings are kept verbatim inside the merge.
    expect(cfg).toContain("esbuild: { jsx: 'automatic' }");
    expect(cfg).toContain("include: ['__tests__/**/*.test.ts']");
  });

  it('stays a bare defineConfig where there is no vitest.shared to import', () => {
    const cfg = scaffold(join(TMP, 'standalone'), 'zz-bare');
    expect(cfg).not.toContain('vitest.shared');
    expect(cfg).toMatch(/export default defineConfig\(/);
    expect(cfg).toContain("esbuild: { jsx: 'automatic' }");
  });
});

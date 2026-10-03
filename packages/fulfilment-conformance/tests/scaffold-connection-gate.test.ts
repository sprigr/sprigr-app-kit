/**
 * The default template's OAuth connection is install-wide: one token set that
 * every agent in the installing company uses, while the install's pages are
 * served to every signed-in member. A generated `GET /oauth/start` that reads
 * no viewer lets any member authorize the install with their own provider
 * account (sprigr-apps#2312 in atlassian, #2357 in asana, procore and
 * bitbucket, all four copied from this scaffold's shape).
 *
 * So this scaffolds the default template for real and checks the result:
 *
 *  1. the gate is generated and wired: `src/lib/viewer.ts` resolves the viewer
 *     through the SDK's `resolveViewerContext`, `/oauth/start` calls it before
 *     it touches D1, and the settings page hides the controls from non-admins;
 *  2. the generated app typechecks against the exact kit versions it pins (an
 *     app-sdk pin that predates `resolveViewerContext` fails here);
 *  3. the generated app's own tests pass, including the role test it ships
 *     with, which drives the real route and page as member, admin and owner.
 *
 * The generated app is not a workspace package, so it gets a node_modules of
 * symlinks into packages that other workspace members already installed,
 * matched to the versions the scaffold pins. It is generated outside the
 * workspace so nothing resolves by walking up into the repo's own
 * node_modules: an import the generated package.json does not declare fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PKG_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const CREATE_APP = join(REPO_ROOT, 'tools', 'create-app.mjs');

const OUT = mkdtempSync(join(tmpdir(), 'sprigr-scaffold-gate-'));

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function scaffold(slug: string, ...extra: string[]): string {
  execFileSync(process.execPath, [CREATE_APP, slug, '--out-dir', OUT, ...extra], { stdio: 'pipe' });
  return join(OUT, slug);
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

/** Exact pins must match exactly; a caret range matches on its major. */
function satisfies(version: string, spec: string): boolean {
  if (/^\d/.test(spec)) return version === spec;
  const caret = /^\^(\d+)\./.exec(spec);
  return caret !== null && version.split('.')[0] === caret[1];
}

/** Where a workspace member has installed `name` at a version matching `spec`. */
function installedIn(member: string, name: string, spec: string): string | undefined {
  const dir = join(member, 'node_modules', name);
  const version = readPackageJson(dir)?.version;
  return version !== undefined && satisfies(version, spec) ? dir : undefined;
}

/**
 * Give the generated app a node_modules of symlinks into packages other
 * workspace members already installed. Members are searched in order of how
 * many of the app's pins they match, so peers (next, react, OpenNext) come
 * from one consistent install wherever possible.
 */
function linkDeps(appDir: string): void {
  const pkg = readPackageJson(appDir) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // What the typecheck and the generated tests actually load. The rest
  // (wrangler, esbuild, coverage) is linked when some member has it.
  const required = new Set([...Object.keys(pkg.dependencies ?? {}), '@types/node', '@types/react', 'vitest']);

  const members = [REPO_ROOT];
  for (const group of ['examples', 'apps', 'packages']) {
    const dir = join(REPO_ROOT, group);
    if (existsSync(dir)) members.push(...readdirSync(dir).map((name) => join(dir, name)));
  }
  const score = (m: string) => Object.entries(deps).filter(([n, s]) => installedIn(m, n, s)).length;
  const ranked = members.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s).map((x) => x.m);

  const missing: string[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    const source = ranked.map((m) => installedIn(m, name, spec)).find((d) => d !== undefined);
    if (!source) {
      if (required.has(name)) missing.push(`${name}@${spec}`);
      continue;
    }
    const link = join(appDir, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(source), link, 'dir');
  }
  if (missing.length > 0) {
    throw new Error(
      `No workspace member has installed ${missing.join(', ')}, which the scaffold pins. ` +
        'Pin the same version in a reference app (examples/harvest tracks the scaffold) and run pnpm install.',
    );
  }
}

/** The parent vitest's own env vars would confuse the nested run. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'TEST'),
  );
}

describe('pnpm create:app (default template, OAuth): the install-wide connection is owner or admin only', () => {
  const dir = scaffold('scaffold-gate');

  beforeAll(() => linkDeps(dir));

  it('pins an app-sdk that exports resolveViewerContext', () => {
    const pkg = readPackageJson(dir);
    const pin = pkg?.dependencies?.['@sprigr/apps-app-sdk'] ?? '';
    const [major, minor] = pin.split('.').map(Number);
    expect(major === 0 ? (minor ?? 0) >= 9 : (major ?? 0) >= 1, `pinned ${pin}`).toBe(true);
  });

  it('generates src/lib/viewer.ts on the SDK resolver, with a 401 and a 403', () => {
    const viewer = read(dir, 'src/lib/viewer.ts');
    expect(viewer).toMatch(/import \{ resolveViewerContext, type ViewerContext \} from '@sprigr\/apps-app-sdk'/);
    expect(viewer).toContain('export async function requireConnectionAdmin(');
    expect(viewer).toContain("new Set(['owner', 'admin'])");
    expect(viewer).toContain('{ status: 401 }');
    expect(viewer).toContain('{ status: 403 }');
  });

  it('gates GET /oauth/start before its first D1 read or write', () => {
    const route = read(dir, 'src/app/oauth/start/route.ts');
    const gate = route.indexOf('await requireConnectionAdmin(req.headers, env)');
    expect(gate).toBeGreaterThan(-1);
    expect(route).toContain('if (!gate.ok) return gate.response;');
    expect(gate).toBeLessThan(route.indexOf('env.DB'));
    expect(gate).toBeLessThan(route.indexOf('await setSetting('));
  });

  it('hides Connect and Reconnect from non-admins on the settings page', () => {
    const page = read(dir, 'src/app/page.tsx');
    expect(page).toContain('canManageConnection(await resolveViewer(');
    const branch = page.indexOf('{canManage ? (');
    expect(branch).toBeGreaterThan(-1);
    expect(page.indexOf('href="oauth/start"')).toBeGreaterThan(branch);
    expect(page.indexOf('href="oauth/start?reconnect=1"')).toBeGreaterThan(branch);
  });

  it('ships a role test for the route and the page', () => {
    expect(existsSync(join(dir, '__tests__', 'connection-admin.test.ts'))).toBe(true);
  });

  it('typechecks against the versions it pins', () => {
    const tsc = join(dirname(createRequire(join(PKG_ROOT, 'package.json')).resolve('typescript/package.json')), 'bin', 'tsc');
    const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', dir], { encoding: 'utf8' });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  }, 180_000);

  it("passes its own tests, including the member/admin/owner role test and the callback's state test", () => {
    const vitest = join(realpathSync(join(dir, 'node_modules', 'vitest')), 'vitest.mjs');
    const run = spawnSync(process.execPath, [vitest, 'run', '--no-file-parallelism'], {
      cwd: dir,
      env: childEnv(),
      encoding: 'utf8',
    });
    const output = `${run.stdout}${run.stderr}`;
    expect(run.status, output).toBe(0);
    expect(output).toContain('connection-admin.test.ts');
    // The callback half of the connection (sprigr-apps#2442): a stateless or
    // forged-csrf call makes no token request; the bouncer's call connects.
    // Its static checks live in scaffold-oauth-callback.test.ts.
    expect(output).toContain('oauth-callback.test.ts');
  }, 180_000);
});

describe('pnpm create:app --no-oauth', () => {
  it('generates no connect route and no gate, because there is no connection to change', () => {
    const dir = scaffold('scaffold-gate-plain', '--no-oauth');
    expect(existsSync(join(dir, 'src', 'app', 'oauth'))).toBe(false);
    expect(existsSync(join(dir, 'src', 'lib', 'viewer.ts'))).toBe(false);
    expect(existsSync(join(dir, '__tests__', 'connection-admin.test.ts'))).toBe(false);
    expect(read(dir, 'src/app/page.tsx')).not.toContain('oauth/start');
  });
});

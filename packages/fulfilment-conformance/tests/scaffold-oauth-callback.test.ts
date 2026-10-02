/**
 * The default template's `<slug>_oauth_callback` must not be a way for an
 * agent to bind the install-wide connection (sprigr-apps#2442).
 *
 * The scaffold used to declare the callback with `state` optional and no
 * `internal` key, so the platform listed it as an agent tool, and the
 * generated handler only checked the csrf inside `if (args.state)` before
 * exchanging the code unconditionally. An agent call with no state and an
 * authorization code minted for another provider account overwrote the
 * install's tokens. The bouncer, the only legitimate caller, always sends
 * state, so the stateless branch served nobody.
 *
 * This scaffolds the default template for real and checks the result: the
 * callback is `internal`, `state` is required, the handler refuses a missing
 * or mismatched state before it reaches the exchange, and the app ships the
 * behavioural test. That test (a stateless call makes no token request and
 * leaves the stored tokens alone; the bouncer's call still connects) is run
 * with the rest of the generated suite by `scaffold-connection-gate.test.ts`,
 * which already links the generated app's dependencies.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CREATE_APP = join(REPO_ROOT, 'tools', 'create-app.mjs');

const OUT = mkdtempSync(join(tmpdir(), 'sprigr-scaffold-callback-'));

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function scaffold(slug: string, ...extra: string[]): string {
  execFileSync(process.execPath, [CREATE_APP, slug, '--out-dir', OUT, ...extra], { stdio: 'pipe' });
  return join(OUT, slug);
}

interface ToolDeclaration {
  name: string;
  internal?: boolean;
  input_schema?: { required?: string[] };
}

function tools(dir: string): ToolDeclaration[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'sprigr-app.json'), 'utf8')) as { tools: ToolDeclaration[] };
  return manifest.tools;
}

describe('pnpm create:app (default template, OAuth): only the bouncer can complete the connection', () => {
  const dir = scaffold('scaffold-callback');
  const handler = readFileSync(join(dir, 'src', 'handlers', 'oauth-callback.ts'), 'utf8');

  it('declares the callback internal, so the platform keeps it off the agent tool list', () => {
    const callback = tools(dir).find((t) => t.name === 'scaffold_callback_oauth_callback');
    expect(callback).toBeDefined();
    expect(callback?.internal).toBe(true);
  });

  it('requires state in the callback input schema', () => {
    const callback = tools(dir).find((t) => t.name === 'scaffold_callback_oauth_callback');
    expect(callback?.input_schema?.required).toEqual(expect.arrayContaining(['code', 'redirectUri', 'state']));
  });

  it('leaves the agent-facing starter tool agent-callable', () => {
    const tool = tools(dir).find((t) => t.name === 'scaffold_callback_tool');
    expect(tool?.internal).toBeUndefined();
  });

  it('refuses a missing state before the exchange, with no optional-state branch left', () => {
    expect(handler).not.toMatch(/if \(args\.state\)/);
    expect(handler).not.toMatch(/state\?: string/);
    const refuseMissing = handler.indexOf("reason: 'missing state'");
    const exchange = handler.indexOf('await completeOAuthCallback(');
    expect(refuseMissing).toBeGreaterThan(-1);
    expect(exchange).toBeGreaterThan(-1);
    expect(refuseMissing).toBeLessThan(exchange);
  });

  it('compares the csrf in constant time and burns it before the exchange', () => {
    expect(handler).toMatch(/import \{ constantTimeEqual, decodeState \} from '@sprigr\/apps-app-sdk'/);
    const compare = handler.indexOf('constantTimeEqual(csrf, expected)');
    const burn = handler.indexOf("await deleteSetting(env.DB, 'oauth_csrf')");
    const exchange = handler.indexOf('await completeOAuthCallback(');
    expect(compare).toBeGreaterThan(-1);
    expect(compare).toBeLessThan(burn);
    expect(burn).toBeLessThan(exchange);
  });

  it('ships the behavioural callback test with the app', () => {
    expect(existsSync(join(dir, '__tests__', 'oauth-callback.test.ts'))).toBe(true);
  });
});

describe('pnpm create:app --no-oauth', () => {
  it('generates no callback tool, handler or callback test', () => {
    const dir = scaffold('scaffold-callback-plain', '--no-oauth');
    expect(tools(dir).some((t) => t.name.endsWith('_oauth_callback'))).toBe(false);
    expect(existsSync(join(dir, 'src', 'handlers', 'oauth-callback.ts'))).toBe(false);
    expect(existsSync(join(dir, '__tests__', 'oauth-callback.test.ts'))).toBe(false);
  });
});

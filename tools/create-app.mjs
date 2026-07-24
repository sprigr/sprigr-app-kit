#!/usr/bin/env node
/**
 * create-app - scaffold a new marketplace app under `apps/<slug>/`.
 *
 * Every app in this repo shares the same skeleton (package.json,
 * tsconfig, next/open-next/wrangler/vitest configs, env typing, D1
 * settings/secrets tables, OAuth plumbing through the publisher-shared
 * bouncer). Before this script, new apps were hand-copied from an
 * existing one, which drags along stale business logic and misses the
 * newest conventions. This generates the skeleton from templates that
 * match the current repo shape.
 *
 * Usage:
 *   pnpm create:app <slug> [--kind integration|tool|agent]
 *                          [--name "Display Name"] [--no-oauth]
 *
 *   <slug>      kebab-case app directory + manifest slug (e.g. my-crm)
 *   --kind      manifest `kind` (default: integration)
 *   --name      display name (default: Title Case of the slug)
 *   --no-oauth  skip the OAuth files, manifest secrets, and oauth-utils
 *               vendor dependency (for apps with no third-party login)
 *
 * After generating, the script prints the manual follow-up checklist
 * (manifest description/scopes, OAuth app registration, etc.). Shared
 * kit code arrives as exact-pinned @sprigr/apps-* npm deps; run
 * `pnpm install` after scaffolding to resolve them.
 *
 * Like sync-vendor.mjs this is dependency-free (Node stdlib only).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");

// ---------------------------------------------------------------------------
// CLI parsing + validation
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const SLUG = positional[0];
const NO_OAUTH = args.includes("--no-oauth");
const kindIdx = args.indexOf("--kind");
const KIND = kindIdx >= 0 ? args[kindIdx + 1] : "integration";
const nameIdx = args.indexOf("--name");

function usage(msg) {
  if (msg) console.error(`[create-app] ERROR: ${msg}\n`);
  console.error(
    'Usage: pnpm create:app <slug> [--kind integration|tool|agent] [--name "Display Name"] [--no-oauth]',
  );
  process.exit(1);
}

if (!SLUG) usage("missing <slug>");
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(SLUG)) {
  usage(`slug "${SLUG}" must be kebab-case: lowercase letters, digits, single hyphens`);
}
if (!["integration", "tool", "agent"].includes(KIND)) {
  usage(`--kind must be integration|tool|agent (got "${KIND}")`);
}
const APP_DIR = join(APPS_DIR, SLUG);
if (existsSync(APP_DIR)) usage(`apps/${SLUG} already exists`);

const SLUG_U = SLUG.replace(/-/g, "_"); // table + tool name segment
const PASCAL = SLUG.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const ENV_PREFIX = SLUG_U.toUpperCase(); // manifest secret prefix
const NAME =
  nameIdx >= 0
    ? args[nameIdx + 1]
    : SLUG.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// Published kit packages, consumed as exact-pinned npm deps. (Vendoring via
// sprigrVendor + pnpm sync:vendor remains available for the unpublished UI
// packages: dashboard-kit, timezone-picker.)
const KIT_DEPS = NO_OAUTH ? ["app-sdk", "d1-kv"] : ["app-sdk", "oauth-utils", "d1-kv"];
const KIT_DEP_VERSION = "0.1.0";

const manifest = {
  sprigr_app: { version: "1" },
  metadata: {
    name: NAME,
    slug: SLUG,
    version: "0.0.1",
    description: `TODO: one-sentence description of what ${NAME} does for an installing tenant.`,
    author: { name: "Sprigr Company", email: "platform@sprigr.com" },
    category: "TODO",
    tags: [],
  },
  kind: KIND,
  runtime: {
    entry: "src/app/page.tsx",
    tier: "ssr",
    framework: "next",
  },
  permissions: {
    scopes: ["tools:register"],
    // Declarative allowlist, not a runtime firewall — but the inbound-OAuth
    // SSRF guard and the agent code-mode sandbox read it. List every host the
    // app calls, INCLUDING the provider's OAuth login host.
    network_domains: NO_OAUTH
      ? []
      : ["TODO-api.example.com", "TODO-login.example.com"],
  },
  secrets: NO_OAUTH
    ? []
    : [
        {
          key: `${ENV_PREFIX}_CLIENT_ID`,
          label: `${NAME} OAuth client id`,
          type: "secret",
          required: true,
          description: `Publisher-provided OAuth client id for the ${NAME} developer app.`,
        },
        {
          key: `${ENV_PREFIX}_CLIENT_SECRET`,
          label: `${NAME} OAuth client secret`,
          type: "secret",
          required: true,
          description: `Publisher-provided OAuth client secret for the ${NAME} developer app.`,
        },
      ],
  migrations: [
    {
      file: "migrations/0001_init.sql",
      version: 1,
      description: "Initial schema: settings + secrets key-value tables.",
    },
  ],
  tools: [
    {
      name: `${SLUG_U}_tool`,
      description: `TODO: describe what the ${NAME} agent tool does. Agents pick tools by this description.`,
      handler: `src/handlers/${SLUG}-tool.ts`,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", description: "TODO: replace with the real tool contract." },
        },
        required: ["action"],
      },
    },
    ...(NO_OAUTH
      ? []
      : [
          {
            name: `${SLUG_U}_oauth_callback`,
            description: `Dispatched by the publisher-shared OAuth bouncer after ${NAME} redirects with a code. Exchanges the code and persists tokens to per-install D1.`,
            handler: "src/handlers/oauth-callback.ts",
            input_schema: {
              type: "object",
              properties: {
                code: { type: "string" },
                redirectUri: { type: "string" },
                state: {
                  type: "string",
                  description:
                    "Raw encoded state from /oauth/start; decode and verify csrf against the stored oauth_csrf.",
                },
                environment: { type: "string" },
                installId: { type: "string" },
              },
              required: ["code", "redirectUri"],
            },
          },
        ]),
  ],
};

const packageJson = {
  name: SLUG,
  version: "0.0.1",
  private: true,
  scripts: {
    build: "next build",
    dev: "next dev",
    start: "next start",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "test:watch": "vitest",
  },
  dependencies: {
    ...Object.fromEntries(KIT_DEPS.map((p) => [`@sprigr/apps-${p}`, KIT_DEP_VERSION])),
    "@opennextjs/cloudflare": "^1.0.0",
    next: "15.5.21",
    react: "19.0.0",
    "react-dom": "19.0.0",
  },
  devDependencies: {
    "@cloudflare/workers-types": "^5.20260722.1",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@vitest/coverage-v8": "2.1.9",
    typescript: "^5.6.0",
    vitest: "^2.0.0",
  },
};

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    lib: ["dom", "dom.iterable", "esnext"],
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    isolatedModules: true,
    incremental: true,
    allowJs: true,
    noEmit: true,
    jsx: "preserve",
    paths: { "@/*": ["./src/*"] },
    plugins: [{ name: "next" }],
  },
  include: ["next-env.d.ts", ".next/types/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
  exclude: ["node_modules", ".next", ".open-next"],
};

const nextConfigJs = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
`;

const openNextConfigTs = `const config = {
  default: {
    override: {
      wrapper: 'cloudflare-node',
      converter: 'edge',
      proxyExternalRequest: 'fetch',
      incrementalCache: 'dummy',
      tagCache: 'dummy',
      queue: 'dummy',
    },
  },
  edgeExternals: ['node:crypto'],
  middleware: {
    external: true,
    override: {
      wrapper: 'cloudflare-edge',
      converter: 'edge',
      proxyExternalRequest: 'fetch',
      incrementalCache: 'dummy',
      tagCache: 'dummy',
      queue: 'dummy',
    },
  },
};

export default config;
`;

const wranglerJsonc = `{
  "name": "${SLUG}",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"]
}
`;

const vitestConfigTs = `/**
 * Vitest config for the ${SLUG} marketplace app.
 *
 * Test files live under \`__tests__/\` (mirroring the source tree).
 * Coverage is opt-in via \`pnpm test -- --coverage\`; vendored packages
 * are excluded because they're tested upstream in \`packages/\`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__/__helpers__/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/vendor/**'],
    },
  },
});
`;

const gitignore = `node_modules/
.next/
.open-next/
out/
*.log
.DS_Store
.env*
*.tsbuildinfo
`;

const nextEnvDts = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const readme = `# ${NAME} (\`${SLUG}\`)

TODO: what this app does, which third-party service it talks to, and any
publisher-side setup (developer app registration, webhook subscriptions).

Scaffolded by \`pnpm create:app\`. See
[docs/build-guide.md](../../docs/build-guide.md) for the full
build/publish guide.
`;

const migration = `-- Per-install D1 schema for the ${NAME} marketplace app.
--
-- D1 is allocated one-per-install by the marketplace runtime and bound
-- as env.DB to handlers + Next.js route code.
--
-- NOTE: this file is IMMUTABLE once shipped (see repo CLAUDE.md).
-- Schema changes go in new numbered migration files.

-- Key-value table backing the OAuth TokenStore / handler-written
-- secrets (refresh_token, access_token, expires_at, ...).
CREATE TABLE ${SLUG_U}_secrets (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Non-secret key-value settings: OAuth CSRF, feature toggles,
-- sync cursors, etc.
CREATE TABLE ${SLUG_U}_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const envTs = `/**
 * ${NAME} - per-install env binding contract.
 *
 * The marketplace runtime binds these onto the per-install WFP script:
 *   - DB          - per-install D1 (always)
 *   - INSTALL_ID / COMPANY_ID / APP_SLUG - runtime-injected identifiers
 *   - SPRIGR_INSTALL_TOKEN / SPRIGR_PLATFORM_BASE - platform API access${
   NO_OAUTH
     ? ""
     : `
 *   - ${ENV_PREFIX}_CLIENT_ID / ${ENV_PREFIX}_CLIENT_SECRET - publisher-
 *     provided manifest secrets, shared across installs (seeded via
 *     \`sprigr app set-publisher-secrets\`)`
 }
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface ${PASCAL}Env {
  DB: D1Like;${
    NO_OAUTH
      ? ""
      : `
  ${ENV_PREFIX}_CLIENT_ID: string;
  ${ENV_PREFIX}_CLIENT_SECRET: string;`
  }
  /** Optional - only present when the runtime injects it. */
  INSTALL_ID?: string;
  /** Optional - only present when the runtime injects it. */
  COMPANY_ID?: string;
  /** Optional - only present when the runtime injects it. */
  APP_SLUG?: string;
  /** Anything else CloudflareEnv has - keeps the type assignable to
   *  the OpenNext-cloudflare CloudflareEnv constraint. */
  [key: string]: unknown;
}

/**
 * Augment the global CloudflareEnv interface (declared by
 * @opennextjs/cloudflare) so \`getCloudflareContext()\` returns an env
 * with our manifest-declared bindings typed.
 */
declare global {
  interface CloudflareEnv extends ${PASCAL}Env {}
}

export {};
${
  NO_OAUTH
    ? ""
    : `
export function requireClientId(env: ${PASCAL}Env): string {
  if (!env.${ENV_PREFIX}_CLIENT_ID) {
    throw new Error('${ENV_PREFIX}_CLIENT_ID not set. Seed publisher secrets before use.');
  }
  return env.${ENV_PREFIX}_CLIENT_ID;
}

export function requireClientSecret(env: ${PASCAL}Env): string {
  if (!env.${ENV_PREFIX}_CLIENT_SECRET) {
    throw new Error('${ENV_PREFIX}_CLIENT_SECRET not set. Seed publisher secrets before use.');
  }
  return env.${ENV_PREFIX}_CLIENT_SECRET;
}
`
}`;

const storeTs = `/**
 * ${NAME} - per-install D1 stores.
 *
 * Thin wrappers around the vendored d1-kv package, pinned to this
 * app's table names (created by migrations/0001_init.sql).
 */

import { makeSettingsStore, makeD1TokenStore } from '@sprigr/apps-d1-kv';
import type { D1Like } from '@sprigr/apps-app-sdk';

export const settings = (db: D1Like) => makeSettingsStore({ db, table: '${SLUG_U}_settings' });
export const tokens = (db: D1Like) => makeD1TokenStore({ db, table: '${SLUG_U}_secrets' });

export async function getSetting(db: D1Like, key: string): Promise<string | null> {
  return settings(db).get(key);
}

export async function setSetting(db: D1Like, key: string, value: string): Promise<void> {
  return settings(db).set(key, value);
}

export async function deleteSetting(db: D1Like, key: string): Promise<void> {
  return settings(db).delete(key);
}
`;

const oauthTs = `/**
 * ${NAME} - OAuth flow primitives.
 *
 * OAuth runs through the publisher-shared bouncer
 * (oauth-bouncer.sprigr.com / staging-oauth-bouncer.sprigr.com): one
 * redirect URI per environment, registered once on the ${NAME}
 * developer app. The bouncer decodes \`state\`, finds this install via
 * the WFP DISPATCHER, and dispatches into the \`${SLUG_U}_oauth_callback\`
 * handler.
 */

import { exchangeAndPersist, type ProviderConfig, type AuthCodeResponse } from '@sprigr/apps-oauth-utils';
import { tokens } from './store';
import type { D1Like } from '@sprigr/apps-app-sdk';

// TODO: replace with the real ${NAME} endpoints.
export const AUTHORIZE_URL = 'https://TODO.example.com/oauth/authorize';
export const TOKEN_URL = 'https://TODO.example.com/oauth/token';

export function providerConfig(clientId: string, clientSecret: string): ProviderConfig {
  return {
    provider: '${SLUG}',
    tokenUrl: TOKEN_URL,
    clientId,
    clientSecret,
  };
}

/** Build the authorize URL for the "Connect ${NAME}" button. */
export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    // TODO: add provider-required params (scope, audience, ...).
  });
  return \`\${AUTHORIZE_URL}?\${params}\`;
}

/** Exchange an authorization code for tokens and persist to D1. */
export async function completeOAuthCallback(args: {
  db: D1Like;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<AuthCodeResponse> {
  const store = tokens(args.db);
  const config = providerConfig(args.clientId, args.clientSecret);
  return exchangeAndPersist(config, store, args.code, { redirectUri: args.redirectUri });
}
`;

const layoutTsx = `export const metadata = {
  title: '${NAME} - Sprigr',
  description: '${NAME} integration for Sprigr',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem', maxWidth: 760 }}>
        {children}
      </body>
    </html>
  );
}
`;

const pageTsx = `/**
 * ${NAME} - per-install settings UI (SSR).
 *
 * This is the manifest \`runtime.entry\`: what a tenant sees when they
 * open the app from the Sprigr portal. Replace with the real settings
 * surface (connection status, configuration, sync history, ...).
 */

export const dynamic = 'force-dynamic';

export default async function Page() {
  return (
    <main>
      <h1>${NAME}</h1>
      <p>TODO: replace with the real per-install settings UI.</p>${
        NO_OAUTH
          ? ""
          : `
      <p>
        <a href="oauth/start">Connect ${NAME}</a>
      </p>`
      }
    </main>
  );
}
`;

const oauthStartRoute = `/**
 * GET /oauth/start
 *
 * Initiates the OAuth flow: mints a CSRF token (stashed in D1 so the
 * callback can verify), packs install_id + CSRF into \`state\`, and
 * redirects the user to ${NAME}'s authorize URL with the publisher-
 * shared bouncer as redirect_uri.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { buildAuthorizeUrl } from '../../../lib/oauth';
import { setSetting } from '../../../lib/store';
import { encodeState, randomHex } from '@sprigr/apps-app-sdk';
import { requireClientId } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { env } = await getCloudflareContext({ async: true });
  const url = new URL(req.url);
  const returnTo = url.searchParams.get('return_to') ?? undefined;
  const installId = env.INSTALL_ID ?? 'unknown';

  // Refuse to restart a completed flow unless explicitly asked
  // (?reconnect=1): a drive-by GET must not clobber a pending csrf or
  // needlessly re-arm the flow once connected.
  const wantsReconnect = url.searchParams.get('reconnect') === '1';
  if (!wantsReconnect) {
    const connected = await env.DB
      .prepare("SELECT value FROM ${SLUG_U}_secrets WHERE key = 'access_token'")
      .bind()
      .first<{ value: string }>();
    if (connected?.value) {
      return NextResponse.redirect(new URL('/', req.url), 303);
    }
  }

  const csrf = randomHex(16);
  await setSetting(env.DB, 'oauth_csrf', csrf);

  // The bouncer is auto-detected from the request hostname so the same
  // bundle works on prod and staging. Override with ${ENV_PREFIX}_REDIRECT_URI
  // for single-install development setups.
  const isStaging = req.url.includes('staging-apps.sprigr.com') || req.url.includes('staging-team.sprigr.com');
  const defaultBouncer = isStaging
    ? 'https://staging-oauth-bouncer.sprigr.com/${SLUG}/oauth/callback'
    : 'https://oauth-bouncer.sprigr.com/${SLUG}/oauth/callback';
  const redirectUri = process.env.${ENV_PREFIX}_REDIRECT_URI ?? defaultBouncer;

  const state = encodeState({
    installId,
    csrf,
    returnTo,
    iat: Date.now(),
  });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: requireClientId(env),
    redirectUri,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}
`;

const oauthCallbackHandler = `/**
 * ${NAME} - OAuth callback handler.
 *
 * The publisher-shared OAuth bouncer receives ${NAME}'s redirect,
 * decodes \`state\` to find this install, and dispatches here with
 * { code, state, redirectUri, environment, installId }. Verifies the
 * csrf from \`state\`, then exchanges the code and persists tokens to
 * per-install D1.
 */

import { completeOAuthCallback } from '../lib/oauth';
import { requireClientId, requireClientSecret } from '../lib/env';
import { getSetting, deleteSetting } from '../lib/store';
import { decodeState } from '@sprigr/apps-app-sdk';
import type { ${PASCAL}Env } from '../lib/env';

interface CallbackArgs {
  code: string;
  redirectUri: string;
  state?: string;
}

type CallbackResult = { ok: true } | { ok: false; reason: string; error?: string };

export async function runOAuthCallback(env: ${PASCAL}Env, args: CallbackArgs): Promise<CallbackResult> {
  try {
    // Verify the csrf minted at /oauth/start. A stale or replayed consent
    // link must fail loudly; the bouncer surfaces \`error\` to the user.
    if (args.state) {
      const { csrf } = decodeState(args.state) as { csrf?: string };
      const expected = await getSetting(env.DB, 'oauth_csrf');
      if (!expected || !csrf || csrf !== expected) {
        return { ok: false, reason: 'csrf mismatch', error: 'expired_or_unknown_csrf' };
      }
      await deleteSetting(env.DB, 'oauth_csrf');
    }
    await completeOAuthCallback({
      db: env.DB,
      clientId: requireClientId(env),
      clientSecret: requireClientSecret(env),
      code: args.code,
      redirectUri: args.redirectUri,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export default {
  ${SLUG_U}_oauth_callback: async (args: CallbackArgs, env: ${PASCAL}Env) => runOAuthCallback(env, args),
};
`;

const toolHandler = `/**
 * ${NAME} - the agent-facing tool handler.
 *
 * Registered in sprigr-app.json as \`${SLUG_U}_tool\`. Agents on the
 * installing tenant call this with the manifest-declared input_schema.
 */

import type { ${PASCAL}Env } from '../lib/env';

interface ToolArgs {
  action: string;
}

type ToolResult = { ok: true; result: unknown } | { ok: false; reason: string };

export async function runTool(env: ${PASCAL}Env, args: ToolArgs): Promise<ToolResult> {
  // TODO: implement the real tool. env.DB is the per-install D1.
  return { ok: false, reason: \`not implemented (action=\${args.action})\` };
}

export default {
  ${SLUG_U}_tool: async (args: ToolArgs, env: ${PASCAL}Env) => runTool(env, args),
};
`;

const smokeTest = `/**
 * Scaffold smoke test - replace with real coverage as handlers gain
 * logic. Keeps \`pnpm test\` green from day one so CI wiring is proven.
 */
import { describe, it, expect } from 'vitest';
${
  NO_OAUTH
    ? `import { runTool } from '../src/handlers/${SLUG}-tool';

describe('${SLUG_U}_tool', () => {
  it('reports not-implemented until the real tool lands', async () => {
    const res = await runTool({ DB: {} as never }, { action: 'ping' });
    expect(res.ok).toBe(false);
  });
});
`
    : `import { runTool } from '../src/handlers/${SLUG}-tool';
import { requireClientId } from '../src/lib/env';

describe('${SLUG_U}_tool', () => {
  it('reports not-implemented until the real tool lands', async () => {
    const res = await runTool({ DB: {} as never } as never, { action: 'ping' });
    expect(res.ok).toBe(false);
  });
});

describe('env guards', () => {
  it('requireClientId throws until publisher secrets are seeded', () => {
    expect(() => requireClientId({ DB: {} as never } as never)).toThrow(/${ENV_PREFIX}_CLIENT_ID/);
  });
});
`
}`;

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------

/** Write `content` to `relPath` under the new app dir, creating parents. */
function put(relPath, content) {
  const abs = join(APP_DIR, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`[create-app]   apps/${SLUG}/${relPath}`);
}

console.log(`[create-app] scaffolding apps/${SLUG} (kind=${KIND}, oauth=${!NO_OAUTH})`);

put("sprigr-app.json", JSON.stringify(manifest, null, 2) + "\n");
put("package.json", JSON.stringify(packageJson, null, 2) + "\n");
put("tsconfig.json", JSON.stringify(tsconfig, null, 2) + "\n");
put("next.config.js", nextConfigJs);
put("open-next.config.ts", openNextConfigTs);
put("wrangler.jsonc", wranglerJsonc);
put("vitest.config.ts", vitestConfigTs);
put(".gitignore", gitignore);
put("next-env.d.ts", nextEnvDts);
put("README.md", readme);
put("migrations/0001_init.sql", migration);
put("src/lib/env.ts", envTs);
put("src/lib/store.ts", storeTs);
put("src/app/layout.tsx", layoutTsx);
put("src/app/page.tsx", pageTsx);
put(`src/handlers/${SLUG}-tool.ts`, toolHandler);
put("__tests__/smoke.test.ts", smokeTest);
if (!NO_OAUTH) {
  put("src/lib/oauth.ts", oauthTs);
  put("src/app/oauth/start/route.ts", oauthStartRoute);
  put("src/handlers/oauth-callback.ts", oauthCallbackHandler);
}

// Mirror the declared vendor packages into the new app.
console.log(`[create-app] kit deps (exact-pinned): ${KIT_DEPS.map((p) => `@sprigr/apps-${p}@${KIT_DEP_VERSION}`).join(", ")}`);

console.log(`
[create-app] done. apps/${SLUG} scaffolded. Next steps:

  1. pnpm install                      # register the new workspace package
  2. Fill in sprigr-app.json TODOs     # description, category, tags, scopes,
                                       # real tool contracts
  ${
    NO_OAUTH
      ? "3. Implement src/handlers/ + src/app/page.tsx"
      : `3. Set the real endpoints in src/lib/oauth.ts (AUTHORIZE_URL, TOKEN_URL,
     provider-required authorize params)
  4. Register a ${NAME} developer app with BOTH bouncer redirect URIs:
       https://oauth-bouncer.sprigr.com/${SLUG}/oauth/callback
       https://staging-oauth-bouncer.sprigr.com/${SLUG}/oauth/callback
  5. Seed publisher secrets after first publish:
       sprigr app set-publisher-secrets --slug ${SLUG} \\
         ${ENV_PREFIX}_CLIENT_ID=... ${ENV_PREFIX}_CLIENT_SECRET=...`
  }
  Then: pnpm -F ${SLUG} typecheck && pnpm -F ${SLUG} test && pnpm -F ${SLUG} build

Publish with:
  sprigr app validate --dir apps/${SLUG}
  sprigr app publish  --dir apps/${SLUG}
Subsequent releases need a version bump first (pnpm bump ${SLUG});
see docs/build-guide.md (publishing).
`);

/**
 * Test helpers for the showcase app.
 *
 *   fakeDb        an in-memory D1 fake covering the SQL the kit stores +
 *                 handlers issue (settings/secrets KV, dedup, sync_state,
 *                 install_config). Enough to drive the D1-local handler paths.
 *   fakeSprigr    a recording env.SPRIGR stub that captures each call
 *                 (namespace.method + args) so tests can ASSERT the exact
 *                 call shape a handler makes, then returns a canned value.
 *   fakeSprigrThrowing  mimics the `sprigr app dev` proxy: every access
 *                 throws the "not available in `sprigr app dev`" message, so
 *                 tests can prove stagingOnly() catches it.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv } from '../../src/lib/env';
import type { SprigrHost } from '../../src/lib/sprigr-host';

// ── in-memory D1 ─────────────────────────────────────────────────────────────
type Table = Map<string, Record<string, unknown>>;

export function fakeDb(): D1Like {
  // One map per table we touch, keyed by primary key.
  const tables: Record<string, Table> = {
    showcase_settings: new Map(),
    showcase_secrets: new Map(),
    showcase_webhook_dedup: new Map(),
    showcase_sync_state: new Map(),
    showcase_install_config: new Map(),
    showcase_webhook_tenants: new Map(),
  };

  const tableFor = (sql: string): { name: string; table: Table } | null => {
    const m = /(showcase_[a-z_]+)/.exec(sql);
    if (!m) return null;
    const name = m[1]!;
    return tables[name] ? { name, table: tables[name]! } : null;
  };

  function makeStmt(sql: string, params: unknown[] = []): {
    bind: (...a: unknown[]) => ReturnType<typeof makeStmt>;
    first: <T>() => Promise<T | null>;
    run: () => Promise<unknown>;
    all: <T>() => Promise<{ results: T[] }>;
  } {
    const s = sql.trim();
    const t = tableFor(s);
    return {
      bind(...a: unknown[]) {
        return makeStmt(sql, a);
      },
      async first<T>(): Promise<T | null> {
        if (!t) return null;
        if (/SELECT value FROM/i.test(s)) {
          const row = t.table.get(String(params[0]));
          return (row ? { value: row.value } : null) as T | null;
        }
        // sync_state read
        if (/SELECT resource, scope, cursor/i.test(s)) {
          const key = `${params[0]}::${params[1]}`;
          return (t.table.get(key) ?? null) as T | null;
        }
        return null;
      },
      async run(): Promise<unknown> {
        if (!t) return { success: true, meta: { changes: 0 } };
        // KV-style settings/secrets/install_config INSERT ... ON CONFLICT (key,value)
        if (/INSERT INTO showcase_(settings|secrets|install_config)/i.test(s)) {
          t.table.set(String(params[0]), { value: params[1] });
          return { success: true, meta: { changes: 1 } };
        }
        // dedup INSERT OR ... (id, claimed_at). ON CONFLICT DO NOTHING semantics.
        if (/INSERT INTO showcase_webhook_dedup/i.test(s)) {
          const id = String(params[0]);
          if (t.table.has(id)) return { success: true, meta: { changes: 0 } };
          t.table.set(id, { id, claimed_at: params[1] });
          return { success: true, meta: { changes: 1 } };
        }
        // webhook_tenants record
        if (/INSERT INTO showcase_webhook_tenants/i.test(s)) {
          t.table.set(String(params[0]), { tenant_id: params[0], path: params[2] ?? params[1] });
          return { success: true, meta: { changes: 1 } };
        }
        // sync_state write (resource, scope, cursor)
        if (/INSERT INTO showcase_sync_state/i.test(s)) {
          const key = `${params[0]}::${params[1]}`;
          t.table.set(key, { resource: params[0], scope: params[1], cursor: params[2], lastRunAt: 'now' });
          return { success: true, meta: { changes: 1 } };
        }
        if (/DELETE FROM/i.test(s)) {
          t.table.delete(String(params[0]));
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (!t) return { results: [] };
        return { results: Array.from(t.table.values()) as T[] };
      },
    };
  }

  return {
    prepare(sql: string) {
      return makeStmt(sql) as unknown as ReturnType<D1Like['prepare']>;
    },
  } as D1Like;
}

// ── recording env.SPRIGR ─────────────────────────────────────────────────────
export interface SprigrCall {
  method: string;
  args: unknown[];
}

export function fakeSprigr(canned: Record<string, unknown> = {}): { host: SprigrHost; calls: SprigrCall[] } {
  const calls: SprigrCall[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const value = canned[method];
    return Promise.resolve(value === undefined ? { ok: true } : value);
  };
  const host = {
    emit: rec('emit'),
    usage: { report: rec('usage.report') },
    registerChannel: rec('registerChannel'),
    registerWebhookTenant: rec('registerWebhookTenant'),
    integrations: { invoke: rec('integrations.invoke') },
    run_workflow: rec('run_workflow'),
    schedules: { create: rec('schedules.create') },
    browser: {
      fetch: rec('browser.fetch'),
      screenshot: rec('browser.screenshot'),
      session: {
        open: rec('browser.session.open'),
        act: rec('browser.session.act'),
        snapshot: rec('browser.session.snapshot'),
        cookies: rec('browser.session.cookies'),
        close: rec('browser.session.close'),
      },
    },
    jobs: {
      start: rec('jobs.start'),
      get: rec('jobs.get'),
      signal: rec('jobs.signal'),
      cancel: rec('jobs.cancel'),
      list: rec('jobs.list'),
    },
    store: { get: rec('store.get'), put: rec('store.put'), delete: rec('store.delete'), list: rec('store.list') },
    data: { import: rec('data.import'), search: rec('data.search'), get: rec('data.get') },
    collections: {
      define: rec('collections.define'),
      ingest: rec('collections.ingest'),
      ingestFromTable: rec('collections.ingestFromTable'),
      query: rec('collections.query'),
      reconcile: rec('collections.reconcile'),
      describe: rec('collections.describe'),
      history: rec('collections.history'),
    },
    invoke: rec('invoke'),
    inbox: { append: rec('inbox.append') },
    fulfillment_services: {
      register: rec('fulfillment_services.register'),
      list: rec('fulfillment_services.list'),
      update: rec('fulfillment_services.update'),
      delete: rec('fulfillment_services.delete'),
    },
    files: { putStream: rec('files.putStream'), url: rec('files.url') },
  } as unknown as SprigrHost;
  return { host, calls };
}

/** Mimics the `sprigr app dev` proxy: any access throws the staging pointer. */
export function fakeSprigrThrowing(): SprigrHost {
  const thrower = (prop: string) => {
    throw new Error(
      `env.SPRIGR.${prop} is not available in \`sprigr app dev\` — the platform host object ` +
        `only exists on the deployed marketplace runtime. Publish to staging to exercise this code path.`,
    );
  };
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        new Proxy(() => thrower(String(prop)), {
          get: () => () => thrower(String(prop)),
          apply: () => thrower(String(prop)),
        }),
    },
  ) as unknown as SprigrHost;
}

// ── env factory ──────────────────────────────────────────────────────────────
export function makeEnv(overrides: Partial<ShowcaseEnv> = {}): ShowcaseEnv {
  const { host } = fakeSprigr();
  return {
    DB: fakeDb(),
    SPRIGR: host,
    ACME_WEBHOOK_SECRET: 'test-webhook-secret',
    ACME_SHARED_WEBHOOK_SECRET: 'test-shared-secret',
    ACME_CLIENT_ID: 'test-client-id',
    ACME_CLIENT_SECRET: 'test-client-secret',
    SHOWCASE_STATE_HMAC_KEY: 'test-state-key',
    INSTALL_ID: 'inst_test',
    COMPANY_ID: 'comp_test',
    APP_SLUG: 'showcase',
    ...overrides,
  };
}

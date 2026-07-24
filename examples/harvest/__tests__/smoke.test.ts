/**
 * Harvest handler tests: dispatcher contract, arg validation, OAuth
 * URL shape. No network - Harvest calls are exercised only up to the
 * "no account linked" guard.
 */
import { describe, it, expect } from 'vitest';
import { runTool } from '../src/handlers/harvest-tool';
import { requireClientId } from '../src/lib/env';
import { buildAuthorizeUrl, AUTHORIZE_URL, TOKEN_URL } from '../src/lib/oauth';
import type { HarvestEnv } from '../src/lib/env';
import type { D1Like } from '@sprigr/apps-app-sdk';

/** Minimal in-memory D1 fake covering the key-value stores' SQL. */
function fakeDb(rows: Record<string, string> = {}): D1Like {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (/^SELECT value FROM/i.test(sql.trim())) {
                const v = rows[String(args[0])];
                return (v === undefined ? null : { value: v }) as T | null;
              }
              return null;
            },
            async run() {
              if (/^INSERT INTO/i.test(sql.trim())) {
                rows[String(args[0])] = String(args[1]);
              } else if (/^DELETE FROM/i.test(sql.trim())) {
                delete rows[String(args[0])];
              }
              return { success: true } as never;
            },
            async all() {
              return { results: [] } as never;
            },
          };
        },
      } as never;
    },
  } as D1Like;
}

function env(rows: Record<string, string> = {}): HarvestEnv {
  return {
    DB: fakeDb(rows),
    HARVEST_CLIENT_ID: 'placeholder-client-id',
    HARVEST_CLIENT_SECRET: 'placeholder-client-secret',
  };
}

describe('harvest tool dispatcher', () => {
  it('rejects unknown actions', async () => {
    const res = await runTool(env(), { action: 'frobnicate' as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Unknown action/);
  });

  it('connection_status reports not connected on an empty install', async () => {
    const res = await runTool(env(), { action: 'connection_status' });
    expect(res).toEqual({
      ok: true,
      result: { connected: false, hint: expect.stringContaining('Connect Harvest') },
    });
  });

  it('connection_status reports the linked account', async () => {
    const res = await runTool(
      env({ harvest_account_id: '12345', harvest_account_name: 'Acme Co' }),
      { action: 'connection_status' },
    );
    expect(res).toEqual({
      ok: true,
      result: { connected: true, account_id: '12345', account_name: 'Acme Co' },
    });
  });

  it('list actions fail with a reconnect hint when no account is linked', async () => {
    const res = await runTool(env(), { action: 'list_clients' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/No Harvest account linked/);
  });

  it('create_time_entry validates required args before any network call', async () => {
    const missingTask = await runTool(env(), {
      action: 'create_time_entry',
      project_id: 1,
      spent_date: '2026-07-24',
    });
    expect(missingTask.ok).toBe(false);
    if (!missingTask.ok) expect(missingTask.reason).toMatch(/task_id/);

    const badDate = await runTool(env(), {
      action: 'create_time_entry',
      project_id: 1,
      task_id: 2,
      spent_date: '24/07/2026',
    });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.reason).toMatch(/spent_date/);
  });
});

describe('oauth', () => {
  it('endpoints point at Harvest ID', () => {
    expect(AUTHORIZE_URL).toBe('https://id.getharvest.com/oauth2/authorize');
    expect(TOKEN_URL).toBe('https://id.getharvest.com/api/v2/oauth2/token');
  });

  it('buildAuthorizeUrl carries client_id, redirect_uri, and state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://staging-oauth-bouncer.sprigr.com/harvest/oauth/callback',
        state: 'abc',
      }),
    );
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://staging-oauth-bouncer.sprigr.com/harvest/oauth/callback',
    );
    expect(url.searchParams.get('state')).toBe('abc');
  });
});

describe('env guards', () => {
  it('requireClientId throws until publisher secrets are seeded', () => {
    expect(() => requireClientId({ DB: fakeDb() } as HarvestEnv)).toThrow(/HARVEST_CLIENT_ID/);
  });
});

/**
 * Showcase Consumer smoke tests: the consumer side of cross-app wiring.
 */

import { describe, it, expect } from 'vitest';
import type { D1Like } from '@sprigr/apps-app-sdk';
import type { ConsumerEnv, ConsumerSprigrHost } from '../src/lib/env';
import { enrichDeal, onDealWon, setConfig } from '../src/handlers/enrich';

function fakeDb(): D1Like {
  const config = new Map<string, string>();
  function stmt(sql: string, params: unknown[] = []): ReturnType<D1Like['prepare']> {
    const s = sql.trim();
    return {
      bind: (...a: unknown[]) => stmt(sql, a),
      async first<T>() {
        if (/SELECT value FROM consumer_install_config/i.test(s)) {
          const v = config.get(String(params[0]));
          return (v === undefined ? null : { value: v }) as T | null;
        }
        return null;
      },
      async run() {
        if (/INSERT INTO consumer_install_config/i.test(s)) config.set(String(params[0]), String(params[1]));
        return { success: true } as never;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
    } as unknown as ReturnType<D1Like['prepare']>;
  }
  return { prepare: (sql: string) => stmt(sql) } as D1Like;
}

interface RecordingHost extends ConsumerSprigrHost {
  calls: Array<{ tool: string; args?: Record<string, unknown> }>;
  providerQueries: string[];
}
/**
 * Two live providers of showcase/contact_lookup, the shape
 * env.SPRIGR.grants.providers returns after install fan-out bound them
 * (decision 0077): the showcase app itself and contact-mirror. `canned`
 * is what every provider answers; by default only the mirror finds the
 * contact, so the test can see the consumer pick the provider that did.
 */
function recordingHost(canned?: (tool: string) => unknown): RecordingHost {
  const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const providerQueries: string[] = [];
  return {
    calls,
    providerQueries,
    invoke(tool: string, args?: Record<string, unknown>) {
      calls.push({ tool, args });
      const answer = canned
        ? canned(tool)
        : tool === 'contact_mirror_lookup_contact'
          ? { found: true, contact: { id: args?.contact_id, source: 'contact-mirror' } }
          : { found: false };
      return Promise.resolve(answer);
    },
    grants: {
      providers(interfaceId: string) {
        providerQueries.push(interfaceId);
        return Promise.resolve([
          { app_slug: 'showcase', install_id: 'inst_s', interface_version: '1.0.0', ops: { lookup_contact: 'showcase_lookup_contact' }, status: 'active' as const },
          { app_slug: 'contact-mirror', install_id: 'inst_m', interface_version: '1.0.0', ops: { lookup_contact: 'contact_mirror_lookup_contact' }, status: 'active' as const },
          { app_slug: 'pending-one', install_id: 'inst_p', interface_version: '1.0.0', ops: { lookup_contact: 'pending_one_lookup_contact' }, status: 'pending_review' as const },
        ]);
      },
    },
  };
}
function throwingHost(): ConsumerSprigrHost {
  const dead = () => {
    throw new Error('env.SPRIGR.grants.providers is not available in `sprigr app dev` — Publish to staging.');
  };
  return { invoke: dead, grants: { providers: dead } };
}
function makeEnv(host: ConsumerSprigrHost): ConsumerEnv {
  return { DB: fakeDb(), SPRIGR: host, INSTALL_ID: 'inst_c', COMPANY_ID: 'comp_c', APP_SLUG: 'showcase-consumer' };
}

describe('consumer cross-app wiring', () => {
  it('enrichDeal asks for the interface providers and calls every ACTIVE one by its bound tool name', async () => {
    const host = recordingHost();
    const res = await enrichDeal(makeEnv(host), { deal_id: 'd1', contact_id: 'c1', amount: 25000 });
    expect(host.providerQueries).toEqual(['showcase/contact_lookup']);
    // Both active providers are called (consumer-owned fan-out); the pending one is not.
    expect(host.calls.map((c) => c.tool).sort()).toEqual(['contact_mirror_lookup_contact', 'showcase_lookup_contact']);
    expect(host.calls.every((c) => c.args?.contact_id === 'c1')).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { high_value: boolean; found: boolean; provider: string; providers_tried: number };
      expect(r.high_value).toBe(true); // 25000 >= default 10000
      expect(r.found).toBe(true);
      expect(r.provider).toBe('contact-mirror'); // the one that found it
      expect(r.providers_tried).toBe(2);
    }
  });

  it('enrichDeal reports not found when no provider resolves the contact', async () => {
    const host = recordingHost(() => ({ found: false }));
    const res = await enrichDeal(makeEnv(host), { contact_id: 'c9', amount: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toMatchObject({ found: false, provider: null, providers_tried: 2 });
  });

  it('enrichDeal validates contact_id', async () => {
    const res = await enrichDeal(makeEnv(recordingHost()), { contact_id: '' } as never);
    expect(res).toEqual({ ok: false, reason: 'contact_id required' });
  });

  it('enrichDeal returns staging_only under the dev stub', async () => {
    const res = await enrichDeal(makeEnv(throwingHost()), { contact_id: 'c1', amount: 1 });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('grants.providers') });
  });

  it('onDealWon routes the event payload through enrichDeal', async () => {
    const host = recordingHost();
    await onDealWon(makeEnv(host), { event: 'showcase.deal.won', eventId: 'e1', payload: { contact_id: 'c2', amount: 5 } });
    expect(host.calls[0]!.args).toEqual({ contact_id: 'c2' });
  });

  it('setConfig mirrors the threshold into D1 and it changes enrichment', async () => {
    const env = makeEnv(recordingHost());
    await setConfig(env, { high_value_threshold: 100 });
    const res = await enrichDeal(env, { contact_id: 'c3', amount: 150 });
    if (res.ok) expect((res.result as { high_value: boolean }).high_value).toBe(true);
  });
});

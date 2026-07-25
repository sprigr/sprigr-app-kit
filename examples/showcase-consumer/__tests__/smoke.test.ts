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
}
function recordingHost(canned?: unknown): RecordingHost {
  const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  return {
    calls,
    invoke(tool: string, args?: Record<string, unknown>) {
      calls.push({ tool, args });
      return Promise.resolve(canned ?? { found: true, contact: { id: args?.contact_id } });
    },
  };
}
function throwingHost(): ConsumerSprigrHost {
  return {
    invoke() {
      throw new Error('env.SPRIGR.invoke is not available in `sprigr app dev` — Publish to staging.');
    },
  };
}
function makeEnv(host: ConsumerSprigrHost): ConsumerEnv {
  return { DB: fakeDb(), SPRIGR: host, INSTALL_ID: 'inst_c', COMPANY_ID: 'comp_c', APP_SLUG: 'showcase-consumer' };
}

describe('consumer cross-app wiring', () => {
  it('enrichDeal calls showcase_lookup_contact with the contact_id', async () => {
    const host = recordingHost();
    const res = await enrichDeal(makeEnv(host), { deal_id: 'd1', contact_id: 'c1', amount: 25000 });
    expect(host.calls).toEqual([{ tool: 'showcase_lookup_contact', args: { contact_id: 'c1' } }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { high_value: boolean; contact: unknown };
      expect(r.high_value).toBe(true); // 25000 >= default 10000
    }
  });

  it('enrichDeal validates contact_id', async () => {
    const res = await enrichDeal(makeEnv(recordingHost()), { contact_id: '' } as never);
    expect(res).toEqual({ ok: false, reason: 'contact_id required' });
  });

  it('enrichDeal returns staging_only under the dev stub', async () => {
    const res = await enrichDeal(makeEnv(throwingHost()), { contact_id: 'c1', amount: 1 });
    expect(res).toEqual({ ok: false, staging_only: true, hint: expect.stringContaining('showcase_lookup_contact') });
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

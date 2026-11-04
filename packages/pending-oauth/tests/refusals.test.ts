/**
 * Refusal markers and consumeOAuthCallback (sprigr-apps#4331): a reload of a
 * callback refused after the consume repeats the refusal, a csrf this install
 * never minted writes nothing, and a completion still wins.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeMockD1 } from './mock-d1';
import { makeOAuthRefusals, consumeOAuthCallback } from '../src/refusals';
import { makeOAuthCompletions, COMPLETION_WINDOW_MS, COMPLETION_TRIM_MS } from '../src/completions';
import { makePendingOAuthStore } from '../src/store';
import type { D1Like } from '../src/types';

const PENDING = 'demo_pending_oauth';
const COMPLETIONS = 'demo_oauth_completions';
const REFUSALS = 'demo_oauth_refusals';

type Pending = { csrf: string; iat: number };
type Refusal = { ok: false; error: string; hint: string };

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setup() {
  const mock = makeMockD1();
  const pending = makePendingOAuthStore<Pending>({ db: mock.db, table: PENDING });
  const completions = makeOAuthCompletions({ db: mock.db, table: COMPLETIONS });
  const refusals = makeOAuthRefusals<Refusal>({ db: mock.db, table: REFUSALS });
  const callback = (csrf: string | null) =>
    consumeOAuthCallback<Pending, Refusal>({ csrf, consume: (c) => pending.consume(c), completions, refusals });
  return { mock, pending, completions, refusals, callback };
}

const REFUSAL: Refusal = {
  ok: false,
  error: 'installation_not_eligible',
  hint: 'Install the GitHub App on an account you belong to, then start again.',
};

describe('consumeOAuthCallback', () => {
  it('replays a refusal recorded after the consume', async () => {
    const { pending, callback } = setup();
    await pending.store({ csrf: 'flow-1', iat: Date.now() });

    const first = await callback('flow-1');
    expect(first.kind).toBe('consumed');
    if (first.kind !== 'consumed') return;
    expect(await first.refuse(REFUSAL)).toEqual(REFUSAL);

    // The reload: the pending row is gone, the refusal is repeated whole.
    expect(await callback('flow-1')).toEqual({ kind: 'refused', refusal: REFUSAL });
  });

  it('writes nothing for a csrf this install never minted', async () => {
    const { mock, callback } = setup();
    const outcome = await callback('forged-csrf');
    expect(outcome).toEqual({ kind: 'unknown' });
    expect(outcome).not.toHaveProperty('refuse');
    expect(mock.refusalRows(REFUSALS)).toEqual({});
    expect(mock.log.some((sql) => sql.startsWith(`INSERT INTO ${REFUSALS}`))).toBe(false);
  });

  it('treats a missing csrf as unknown without touching D1', async () => {
    const { mock, callback } = setup();
    expect(await callback(null)).toEqual({ kind: 'unknown' });
    expect(await callback('')).toEqual({ kind: 'unknown' });
    expect(mock.log).toEqual([]);
  });

  it('reports already_connected over a refusal for the same flow', async () => {
    const { pending, completions, callback } = setup();
    await pending.store({ csrf: 'flow-2', iat: Date.now() });
    const first = await callback('flow-2');
    if (first.kind !== 'consumed') throw new Error('expected consumed');
    await completions.record('flow-2');
    await first.refuse(REFUSAL); // a late failure after the tokens landed
    expect(await callback('flow-2')).toEqual({ kind: 'already_connected' });
  });

  it('does not make a refused csrf consumable again', async () => {
    const { mock, pending, callback } = setup();
    await pending.store({ csrf: 'flow-3', iat: Date.now() });
    const first = await callback('flow-3');
    if (first.kind !== 'consumed') throw new Error('expected consumed');
    await first.refuse(REFUSAL);
    expect(await pending.consume('flow-3')).toBeNull();
    expect(mock.rows(PENDING)['flow-3']).toBeUndefined();
  });
});

describe('makeOAuthRefusals', () => {
  it('stores sha-256(csrf) and never the csrf itself', async () => {
    const { mock, refusals } = setup();
    await refusals.record('secret-csrf-value', REFUSAL);
    expect(Object.keys(mock.refusalRows(REFUSALS))).toEqual([await sha256Hex('secret-csrf-value')]);
    expect(mock.log.join('\n')).not.toContain('secret-csrf-value');
  });

  it('answers only within the window and the sweep keeps fresh markers', async () => {
    const { mock, refusals } = setup();
    await refusals.record('stale', REFUSAL);
    await refusals.record('fresh', REFUSAL);
    const stale = await sha256Hex('stale');

    mock.refusalRows(REFUSALS)[stale]!.refused_at = Date.now() - COMPLETION_WINDOW_MS - 60_000;
    expect(await refusals.recent('stale')).toBeNull();
    expect(await refusals.recent('stale', 2 * COMPLETION_WINDOW_MS)).toEqual(REFUSAL);

    mock.refusalRows(REFUSALS)[stale]!.refused_at = Date.now() - COMPLETION_TRIM_MS - 60_000;
    await refusals.trimExpired();
    expect(mock.refusalRows(REFUSALS)[stale]).toBeUndefined();
    expect(await refusals.recent('fresh')).toEqual(REFUSAL);
  });

  it('reads a plain-text row as { reason }', async () => {
    const { mock, refusals } = setup();
    mock.refusalRows(REFUSALS)[await sha256Hex('legacy')] = {
      reason: 'agent_bind_refused: already connected for that person',
      refused_at: Date.now(),
    };
    const legacy = makeOAuthRefusals<{ reason: string }>({ db: mock.db, table: REFUSALS });
    expect(await legacy.recent('legacy')).toEqual({ reason: 'agent_bind_refused: already connected for that person' });
    expect(await refusals.recent('unknown')).toBeNull();
  });

  it('is best-effort: a failing D1 never throws, and a lookup reads as a miss', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const brokenDb: D1Like = {
      prepare() {
        throw new Error('D1 is down');
      },
    };
    try {
      const r = makeOAuthRefusals<Refusal>({ db: brokenDb, table: REFUSALS });
      await expect(r.record('x', REFUSAL)).resolves.toBeUndefined();
      await expect(r.recent('x')).resolves.toBeNull();
      await expect(r.trimExpired()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a table name that is not a plain identifier', () => {
    const { db } = makeMockD1();
    expect(() => makeOAuthRefusals({ db, table: 'x; DROP TABLE y' })).toThrow(/plain SQL identifier/);
  });
});

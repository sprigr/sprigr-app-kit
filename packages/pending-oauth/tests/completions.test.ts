/**
 * Unit tests for the shared OAuth completion markers.
 *
 * These pin what microsoft-365 (0.37.0) and quickbooks relied on when each
 * carried its own copy: the marker is a sha-256 of the csrf and never the
 * csrf, a hit only answers within the window, a miss stays a miss, the sweep
 * keeps anything still answerable, and every operation is best-effort. They
 * also pin that recording a completion never resurrects a consumed pending
 * row, since that would reopen the replay window delete-on-read closes.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeMockD1 } from './mock-d1';
import {
  makeOAuthCompletions,
  COMPLETION_WINDOW_MS,
  COMPLETION_TRIM_MS,
} from '../src/completions';
import { makePendingOAuthStore } from '../src/store';
import type { D1Like } from '../src/types';

const TABLE = 'demo_oauth_completions';
const PENDING = 'demo_pending_oauth';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every statement rejects, at prepare, bind, run and first alike. */
const brokenDb: D1Like = {
  prepare() {
    throw new Error('D1 is down');
  },
};

describe('makeOAuthCompletions', () => {
  it('recognises a csrf whose flow completed', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('csrf-that-worked');
    expect(await c.wasRecentlyCompleted('csrf-that-worked')).toBe(true);
  });

  // The branch that keeps each app's existing refusal meaning what it says:
  // a forged or unknown state must stay unrecognised.
  it('does not recognise a csrf that never completed', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('csrf-that-worked');
    expect(await c.wasRecentlyCompleted('some-other-csrf')).toBe(false);
    expect(await c.wasRecentlyCompleted('')).toBe(false);
  });

  it('stores sha-256(csrf) and never the csrf itself', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('secret-csrf-value');
    const keys = Object.keys(mock.completionRows(TABLE));
    expect(keys).toEqual([await sha256Hex('secret-csrf-value')]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.log.join('\n')).not.toContain('secret-csrf-value');
  });

  it('answers only within the window (1h by default)', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('stale');
    const hash = await sha256Hex('stale');

    mock.completionRows(TABLE)[hash] = { completed_at: Date.now() - COMPLETION_WINDOW_MS + 60_000 };
    expect(await c.wasRecentlyCompleted('stale')).toBe(true);

    mock.completionRows(TABLE)[hash] = { completed_at: Date.now() - COMPLETION_WINDOW_MS - 60_000 };
    expect(await c.wasRecentlyCompleted('stale')).toBe(false);

    // An explicit window still overrides the default, as the per-app copies
    // allowed.
    expect(await c.wasRecentlyCompleted('stale', 2 * COMPLETION_WINDOW_MS)).toBe(true);
  });

  it('keeps the window generous and the trim above it', () => {
    expect(COMPLETION_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(COMPLETION_TRIM_MS).toBe(24 * 60 * 60 * 1000);
    // A row swept while still answerable would put the red page back.
    expect(COMPLETION_TRIM_MS).toBeGreaterThan(COMPLETION_WINDOW_MS);
  });

  it('re-recording refreshes completed_at rather than adding a row', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('twice');
    const hash = await sha256Hex('twice');
    mock.completionRows(TABLE)[hash] = { completed_at: 1 };
    await c.record('twice');
    expect(Object.keys(mock.completionRows(TABLE))).toEqual([hash]);
    expect(mock.completionRows(TABLE)[hash]!.completed_at).toBeGreaterThan(1);
  });

  it('sweeps markers past 24h and keeps fresh ones', async () => {
    const mock = makeMockD1();
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });
    await c.record('ancient');
    const ancient = await sha256Hex('ancient');
    mock.completionRows(TABLE)[ancient] = { completed_at: Date.now() - COMPLETION_TRIM_MS - 60_000 };
    await c.record('fresh');

    await c.trimExpired();

    expect(mock.completionRows(TABLE)[ancient]).toBeUndefined();
    expect(await c.wasRecentlyCompleted('fresh')).toBe(true);
  });

  it('scopes every statement to its own table', async () => {
    const mock = makeMockD1();
    const a = makeOAuthCompletions({ db: mock.db, table: 'a_oauth_completions' });
    const b = makeOAuthCompletions({ db: mock.db, table: 'b_oauth_completions' });
    await a.record('shared-csrf');
    expect(await b.wasRecentlyCompleted('shared-csrf')).toBe(false);
    expect(await a.wasRecentlyCompleted('shared-csrf')).toBe(true);
  });

  // The marker is a SEPARATE fact in a SEPARATE table. Recording one must not
  // make a consumed csrf consumable again.
  it('does not make a consumed pending csrf consumable again', async () => {
    const mock = makeMockD1();
    const pending = makePendingOAuthStore<{ csrf: string; iat: number }>({ db: mock.db, table: PENDING });
    const c = makeOAuthCompletions({ db: mock.db, table: TABLE });

    await pending.store({ csrf: 'once', iat: Date.now() });
    expect(await pending.consume('once')).not.toBeNull();
    await c.record('once');
    expect(await pending.consume('once')).toBeNull();
    expect(mock.rows(PENDING)['once']).toBeUndefined();
  });

  it('is best-effort: a failing D1 never throws, and a lookup reads as a miss', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = makeOAuthCompletions({ db: brokenDb, table: TABLE });
      await expect(c.record('x')).resolves.toBeUndefined();
      await expect(c.wasRecentlyCompleted('x')).resolves.toBe(false);
      await expect(c.trimExpired()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(3);
      for (const call of warn.mock.calls) expect(String(call[0])).toMatch(/^\[oauth-completions\]/);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a table name that is not a plain identifier', () => {
    const { db } = makeMockD1();
    expect(() => makeOAuthCompletions({ db, table: 'x; DROP TABLE y' })).toThrow(/plain SQL identifier/);
    expect(() => makeOAuthCompletions({ db, table: '' })).toThrow(/plain SQL identifier/);
  });
});

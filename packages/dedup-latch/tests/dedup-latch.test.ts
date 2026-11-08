import { describe, expect, it } from 'vitest';
import { makeDedupLatch } from '../src/dedup-latch';
import { makeMockD1 } from './mock-d1';

describe('makeDedupLatch', () => {
  it('rejects a non-identifier table name', () => {
    const { db } = makeMockD1();
    expect(() => makeDedupLatch({ db, table: 'bad; DROP', ttlSec: 60 })).toThrow(
      /not a plain SQL identifier/,
    );
  });

  it('rejects a non-positive ttl', () => {
    const { db } = makeMockD1();
    expect(() => makeDedupLatch({ db, table: 't', ttlSec: 0 })).toThrow(/positive/);
    expect(() => makeDedupLatch({ db, table: 't', ttlSec: -5 })).toThrow(/positive/);
    expect(() => makeDedupLatch({ db, table: 't', ttlSec: NaN })).toThrow(/positive/);
  });

  it('tryClaim returns true on first call', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
  });

  it('tryClaim returns false on second call with same id', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
    expect(await latch.tryClaim('event-1')).toBe(false);
  });

  it('tryClaim with a different id is independent', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
    expect(await latch.tryClaim('event-2')).toBe(true);
  });

  it('tryClaim writes a row with expires_at = now + ttlSec', async () => {
    const { db, state } = makeMockD1();
    const before = Date.now();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    await latch.tryClaim('event-1');
    const row = state.rows.get('event-1');
    expect(row).toBeDefined();
    const expires = Date.parse(row!.expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000 + 1_000);
  });

  it('sweep deletes only expired rows', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const { db, state } = makeMockD1([
      ['old-1', { expires_at: past }],
      ['old-2', { expires_at: past }],
      ['live-1', { expires_at: future }],
    ]);
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    const result = await latch.sweep();
    expect(result.deleted).toBe(2);
    expect(state.rows.has('old-1')).toBe(false);
    expect(state.rows.has('old-2')).toBe(false);
    expect(state.rows.has('live-1')).toBe(true);
  });

  it('sweep clears a row that expired earlier the SAME UTC day (the datetime(\'now\') format bug)', async () => {
    // Regression for the microsoft-365 lease outage of 2026-09-03: rows carry
    // ISO expires_at, and against a space-separated datetime('now') nothing
    // on the same date ever compared as expired. 60s ago is on today's date
    // except for a one-minute window after midnight UTC, so also pin a row
    // one second ago.
    const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const aSecondAgo = new Date(Date.now() - 1_000).toISOString();
    const { db, state } = makeMockD1([
      ['stale-lease', { expires_at: aMinuteAgo }],
      ['just-expired', { expires_at: aSecondAgo }],
    ]);
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 150 });
    expect(await latch.tryClaim('stale-lease')).toBe(false);
    const result = await latch.sweep();
    expect(result.deleted).toBe(2);
    expect(state.rows.size).toBe(0);
    expect(await latch.tryClaim('stale-lease')).toBe(true);
  });

  it('sweep returns 0 when nothing has expired', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { db } = makeMockD1([['live-1', { expires_at: future }]]);
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    const result = await latch.sweep();
    expect(result.deleted).toBe(0);
  });

  it('once claimed, tryClaim remains false even after ttl (until swept)', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    await latch.tryClaim('event-1');
    expect(await latch.tryClaim('event-1')).toBe(false);
    // No sweep yet - row still exists, unique constraint still latches.
    expect(await latch.tryClaim('event-1')).toBe(false);
  });

  it('once swept, the same id can be re-claimed', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { db } = makeMockD1([['event-1', { expires_at: past }]]);
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(false);
    await latch.sweep();
    expect(await latch.tryClaim('event-1')).toBe(true);
  });
});

describe('makeDedupLatch release (#87 S025-07, at-least-once retry mode)', () => {
  it('release removes a claimed row and returns true', async () => {
    const { db, state } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
    expect(await latch.release('event-1')).toBe(true);
    expect(state.rows.has('event-1')).toBe(false);
  });

  it('after release, a redelivery re-claims and reprocesses', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
    // a redelivery mid-process is still deduped
    expect(await latch.tryClaim('event-1')).toBe(false);
    // processing failed -> unlatch
    expect(await latch.release('event-1')).toBe(true);
    // the next redelivery re-claims
    expect(await latch.tryClaim('event-1')).toBe(true);
  });

  it('release returns false when the id was never claimed', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.release('never')).toBe(false);
  });

  it('release returns false the second time (row already gone)', async () => {
    const { db } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    await latch.tryClaim('event-1');
    expect(await latch.release('event-1')).toBe(true);
    expect(await latch.release('event-1')).toBe(false);
  });

  it('release ignores expiry: it removes a not-yet-expired claim', async () => {
    // sweep would keep this future-expiry row; release deletes it anyway,
    // proving release is not gated on expires_at.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const { db, state } = makeMockD1([['event-1', { expires_at: future }]]);
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect((await latch.sweep()).deleted).toBe(0);
    expect(await latch.release('event-1')).toBe(true);
    expect(state.rows.has('event-1')).toBe(false);
  });

  it('release is scoped to its id; other claims survive', async () => {
    const { db, state } = makeMockD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    await latch.tryClaim('event-1');
    await latch.tryClaim('event-2');
    expect(await latch.release('event-1')).toBe(true);
    expect(state.rows.has('event-1')).toBe(false);
    expect(state.rows.has('event-2')).toBe(true);
  });
});

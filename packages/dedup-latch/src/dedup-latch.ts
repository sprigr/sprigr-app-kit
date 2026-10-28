/**
 * D1-backed dedup latch for any at-least-once delivery source.
 *
 * Use cases: webhook redeliveries from a third-party provider, queue
 * retries, idempotent task dispatch, exactly-once processing of
 * eventually-consistent events. The package is provider-agnostic.
 *
 * Schema this expects (apps own the migration; pick whatever table
 * name suits, the package only requires the column shape):
 *
 *   CREATE TABLE <app>_webhook_dedup (
 *     id          TEXT PRIMARY KEY,
 *     claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
 *     expires_at  TEXT NOT NULL
 *   );
 *   CREATE INDEX idx_<app>_webhook_dedup_expires
 *     ON <app>_webhook_dedup(expires_at);
 *
 * Usage in a handler:
 *
 *   const latch = makeDedupLatch({ db: env.DB, table: 'webhook_dedup', ttlSec: 7*24*3600 });
 *   const dedupId = appComputedIdFor(envelope);  // app picks the shape
 *   const firstSeen = await latch.tryClaim(dedupId);
 *   if (!firstSeen) {
 *     // Already processed. Short-circuit.
 *     return { status: 200, ok: true, reason: 'duplicate' };
 *   }
 *   // ... process ...
 *
 * The dedup key shape is the app's choice. Common patterns:
 *   - `<topic>:<resourceId>:<updatedAt>` for webhooks that carry the
 *     updated-at timestamp (Shopify, BigCommerce, etc.).
 *   - `<event_type>:<resource_id>:<timestamp>` for systems that POST
 *     a synthetic event id with a custom auth header (Procore-style).
 *   - The provider's own delivery id when present (`X-Delivery-Id`
 *     style headers).
 *
 * Atomicity: relies on SQLite's `INSERT ... ON CONFLICT DO NOTHING`
 * + `meta.changes` to detect whether the row was actually inserted.
 * Concurrent calls with the same id race on the unique constraint;
 * exactly one wins and returns true, the rest return false.
 *
 * Expiry: rows older than `expires_at` are kept until `sweep()` runs.
 * Apps should schedule a daily sweep via env.SPRIGR.schedules.create.
 * The sweep is best-effort; a delayed sweep doesn't break correctness
 * (the unique constraint still latches future re-deliveries against
 * existing rows even if expired). One sweep() removes at most 5000 rows
 * by default, 1000 per statement; `more: true` means the cap was hit and
 * the next scheduled sweep carries on with the backlog.
 */

import type { D1Like, D1RunResult } from './types';

export interface DedupLatch {
  /**
   * Atomically attempt to claim `id`. Returns true if this caller
   * was the first to claim (the row was just inserted). Returns
   * false if `id` was already claimed.
   */
  tryClaim(id: string): Promise<boolean>;

  /**
   * Delete rows with `expires_at <= now()`, in bounded batches. Returns
   * the number deleted, and `more: true` when the per-call cap was
   * reached and expired rows may remain (call again on the next tick).
   * Safe to call any time; missed sweeps don't break correctness.
   */
  sweep(opts?: SweepOpts): Promise<{ deleted: number; more: boolean }>;
}

export interface SweepOpts {
  /** Most rows one DELETE statement removes. Default 1000. */
  batch?: number;
  /** Most rows one sweep() call removes, across its statements. Default 5000. */
  max?: number;
}

const DEFAULT_SWEEP_BATCH = 1000;
const DEFAULT_SWEEP_MAX = 5000;

export interface MakeDedupLatchOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
  /** Time-to-live for each claim, in seconds. */
  ttlSec: number;
}

export function makeDedupLatch(opts: MakeDedupLatchOpts): DedupLatch {
  const { db, table, ttlSec } = opts;
  assertIdent(table);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new Error(`dedup-latch: ttlSec must be a positive number, got ${ttlSec}`);
  }

  return {
    async tryClaim(id) {
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      const raw = await db
        .prepare(
          `INSERT INTO ${table} (id, claimed_at, expires_at)
             VALUES (?, datetime('now'), ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(id, expiresAt)
        .run();
      const changes = (raw as D1RunResult | null)?.meta?.changes ?? 0;
      return changes > 0;
    },
    async sweep(sweepOpts = {}) {
      return sweepExpired(db, table, sweepOpts);
    },
  };
}

/**
 * Delete expired rows in bounded batches; shared by makeDedupLatch and
 * makeIdempotentWrite, whose tables both key on `id` and expire on `expires_at`.
 */
export async function sweepExpired(
  db: D1Like,
  table: string,
  sweepOpts: SweepOpts = {},
): Promise<{ deleted: number; more: boolean }> {
  const batch = sweepOpts.batch ?? DEFAULT_SWEEP_BATCH;
  const max = sweepOpts.max ?? DEFAULT_SWEEP_MAX;
  assertPositiveInt('batch', batch);
  assertPositiveInt('max', max);
  // `expires_at` is written by tryClaim as an ISO string
  // (`2026-09-03T16:25:26.636Z`). SQLite compares TEXT byte-wise, and
  // `datetime('now')` renders `2026-09-03 16:25:26`: same date prefix,
  // then 'T' (0x54) sorts AFTER ' ' (0x20), so an expired row never
  // compared <= "now" until the UTC date rolled over. For webhook dedup
  // that only meant rows lingered a day; for a tick LEASE it meant a
  // lease left by a dead invocation blocked every tick until midnight
  // UTC (microsoft-365 mail sync, two prod tenants, 2026-09-03). Render
  // "now" in the SAME format the rows carry.
  //
  // Bounded (sprigr-app-kit#126): the first sweep on a table that was
  // never swept used to delete the whole expired backlog in one
  // statement. D1 has no `DELETE ... LIMIT`, so each statement picks at
  // most `batch` ids through a subquery, and the loop stops at `max`.
  let deleted = 0;
  while (deleted < max) {
    const limit = Math.min(batch, max - deleted);
    const raw = await db
      .prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') LIMIT ?)`,
      )
      .bind(limit)
      .run();
    const n = (raw as D1RunResult | null)?.meta?.changes ?? 0;
    deleted += n;
    if (n < limit) return { deleted, more: false };
  }
  return { deleted, more: true };
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`dedup-latch: sweep ${name} must be a positive integer, got ${value}`);
  }
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `dedup-latch: table name "${name}" is not a plain SQL identifier`,
    );
  }
}

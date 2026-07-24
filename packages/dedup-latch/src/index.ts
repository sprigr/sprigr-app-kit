/**
 * @sprigr/apps-dedup-latch
 *
 * D1-backed "have we seen this id?" latch for at-least-once delivery
 * sources (webhook redeliveries, queue retries). One factory:
 *
 *   makeDedupLatch({db, table, ttlSec}) → { tryClaim, sweep }
 *
 * See `dedup-latch.ts` for full schema + usage details.
 */

export { makeDedupLatch } from './dedup-latch';
export type { DedupLatch, MakeDedupLatchOpts } from './dedup-latch';
export type { D1Like, D1PreparedStatementLike, D1RunResult } from './types';

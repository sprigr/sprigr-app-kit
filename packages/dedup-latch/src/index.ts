/**
 * @sprigr/apps-dedup-latch
 *
 * D1-backed "have we seen this id?" latch for at-least-once delivery
 * sources (webhook redeliveries, queue retries). One factory:
 *
 *   makeDedupLatch({db, table, ttlSec}) → { tryClaim, sweep }
 *
 * See `dedup-latch.ts` for full schema + usage details.
 *
 * Also: makeIdempotentWrite({db, table}) → { run, sweep } — answer a retried
 * WRITE from its first outcome, keyed on the platform's `args._write_key`
 * (sprigr-team decision 0260). See `idempotent-write.ts`.
 */

export { makeDedupLatch } from './dedup-latch';
export type { DedupLatch, MakeDedupLatchOpts } from './dedup-latch';
export type { D1Like, D1PreparedStatementLike, D1RunResult } from './types';
export { makeIdempotentWrite, idempotentToolResult } from './idempotent-write';
export type { IdempotentWrite, IdempotentWriteOutcome, IdempotentWriteRefusal, MakeIdempotentWriteOpts, StoredResultTooLarge } from './idempotent-write';

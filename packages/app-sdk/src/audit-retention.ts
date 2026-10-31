/**
 * Bounded age sweep for an app's D1 audit table (sprigr-apps#4001).
 *
 * An app's `*_audit` table holds errors and lifecycle events; routine
 * successes belong in the platform log (`logToPlatform`). Even so the table
 * grows forever unless something deletes old rows, and a single
 * `DELETE ... WHERE ts < ?` on a table that was never swept deletes the whole
 * backlog in one statement. sprigr-apps#4001 lists the apps that each carry
 * their own copy of this sweep; this is the shared one.
 *
 * The sweep walks the integer primary key, not the time column. Ids are
 * assigned in insert order, so the lowest ids are the oldest rows: each
 * statement takes the `batch` lowest ids and deletes the ones past
 * retention. That needs no index on the time column (several audit tables
 * only index `(kind, created_at)`, which a `created_at < ?` predicate cannot
 * use), reads at most `batch` rows per statement, and never scans the rest
 * of the table. A statement that deletes fewer than `batch` rows has reached
 * rows inside retention, so the sweep stops there.
 */

import type { D1Like } from './index';

export interface PruneAuditTableOpts {
  /** The audit table, as a plain SQL identifier. */
  table: string;
  /** The column that records when the row was written. */
  timeColumn: string;
  /**
   * How `timeColumn` stores time: `'epoch_ms'` for `Date.now()` integers, or
   * `'sqlite_datetime'` for the UTC text `datetime('now')` writes
   * (`YYYY-MM-DD HH:MM:SS`).
   */
  timeFormat: 'epoch_ms' | 'sqlite_datetime';
  /** Rows written longer ago than this are deleted. */
  retentionMs: number;
  /** The integer primary key. Default `'id'`; use `'rowid'` for a table that declares none. */
  idColumn?: string;
  /** Most rows one DELETE statement removes. Default 1000. */
  batch?: number;
  /** Most rows one call removes, across its statements. Default 5000. */
  max?: number;
  /** The current time in epoch milliseconds. Default `Date.now()`. */
  now?: number;
}

export interface PruneAuditTableResult {
  deleted: number;
  /** True when the `max` cap was reached and old rows may remain: the next call carries on. */
  more: boolean;
}

const DEFAULT_BATCH = 1000;
const DEFAULT_MAX = 5000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Delete `opts.table` rows older than `opts.retentionMs`, oldest first, in
 * bounded batches. Run it from an existing low-frequency tick; a backlog
 * larger than `max` clears over the next calls.
 *
 * A D1 error rejects the promise. Wrap the call so a failed sweep never
 * fails the tick it rides on.
 */
export async function pruneAuditTable(db: D1Like, opts: PruneAuditTableOpts): Promise<PruneAuditTableResult> {
  const id = opts.idColumn ?? 'id';
  for (const [name, value] of [['table', opts.table], ['timeColumn', opts.timeColumn], ['idColumn', id]] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new Error(`pruneAuditTable: ${name} must be a plain SQL identifier, got ${JSON.stringify(value)}`);
    }
  }
  if (opts.timeFormat !== 'epoch_ms' && opts.timeFormat !== 'sqlite_datetime') {
    throw new Error(`pruneAuditTable: timeFormat must be 'epoch_ms' or 'sqlite_datetime', got ${JSON.stringify(opts.timeFormat)}`);
  }
  if (!Number.isFinite(opts.retentionMs) || opts.retentionMs <= 0) {
    throw new Error(`pruneAuditTable: retentionMs must be a positive number, got ${opts.retentionMs}`);
  }
  const batch = opts.batch ?? DEFAULT_BATCH;
  const max = opts.max ?? DEFAULT_MAX;
  assertPositiveInt('batch', batch);
  assertPositiveInt('max', max);

  const cutoffMs = (opts.now ?? Date.now()) - opts.retentionMs;
  const cutoff = opts.timeFormat === 'epoch_ms' ? cutoffMs : sqliteDatetime(cutoffMs);
  const sql =
    `DELETE FROM ${opts.table} WHERE ${id} IN (` +
    `SELECT k FROM (SELECT ${id} AS k, ${opts.timeColumn} AS t FROM ${opts.table} ORDER BY ${id} LIMIT ?) WHERE t < ?)`;

  let deleted = 0;
  while (deleted < max) {
    const limit = Math.min(batch, max - deleted);
    const raw = await db.prepare(sql).bind(limit, cutoff).run();
    const n = (raw as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
    deleted += n;
    if (n < limit) return { deleted, more: false };
  }
  return { deleted, more: true };
}

/** `ms` as the UTC text SQLite's `datetime('now')` writes. */
function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`pruneAuditTable: ${name} must be a positive integer, got ${value}`);
  }
}

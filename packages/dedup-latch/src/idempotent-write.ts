/**
 * D1-backed idempotent write (sprigr-team decision 0260, issue #12216).
 *
 * The platform gives a write dispatch 25 s and never retries it. When one
 * times out, the agent is told to verify and retry only if it did not land,
 * but a slow upstream often finishes after the 25 s, so the retry would write
 * twice. For a tool that declares `idempotency: { mode: 'request' }` the
 * platform sends a content-stable write key (the turn, workflow step, tool and
 * input, with no per-call id), surfaced to the handler as `args._write_key`.
 * This helper keys a per-install claim on it and answers a repeat from the
 * first call's outcome:
 *
 *   - first call: claims the key, runs the write, stores its result;
 *   - repeat after it finished: returns the stored result, the write does NOT
 *     run again (`replayed`);
 *   - repeat while it is still running: refused (`in_progress`), never run;
 *   - repeat after the first call died mid-write (claim older than
 *     `staleRunningSec` and never finished): refused ONCE with
 *     `outcome_unknown`, telling the agent to check upstream; the next
 *     identical attempt runs;
 *   - the write throws: the claim is released, so a real retry can run.
 *     When the error means the write MAY have landed (a timeout after the
 *     request went out), `releaseOnError` returns false and the claim turns
 *     `interrupted` instead, so the next repeat is told to check upstream.
 *
 * Schema this expects (apps own the migration; the table name is the app's):
 *
 *   CREATE TABLE <app>_write_keys (
 *     id          TEXT PRIMARY KEY,
 *     state       TEXT NOT NULL,   -- running | done | interrupted | unknown
 *     result      TEXT,            -- JSON of the result once done
 *     claimed_at  TEXT NOT NULL,   -- ISO 8601, set at claim
 *     expires_at  TEXT NOT NULL    -- ISO 8601
 *   );
 *
 * D1 cost (sprigr-team CLAUDE.md "D1 rows written are a bill"): one insert
 * plus one update per guarded write, a TTL of 24 h by default (it only needs
 * to outlive the agent's retry), a sweep the app schedules, and NO secondary
 * index: the sweep scans a table that holds at most a day of writes.
 *
 * Timestamps are written AND compared as ISO strings
 * (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`), never against `datetime('now')`,
 * whose format sorts differently (see the sweep note in dedup-latch.ts).
 *
 * Usage in a tool handler:
 *
 *   const writes = makeIdempotentWrite({ db: env.DB, table: 'simpro_write_keys' });
 *   const outcome = await writes.run(args._write_key, () => createQuoteNote(env, args));
 *   return idempotentToolResult(outcome);
 */

import type { D1Like, D1RunResult } from './types';

const NOW_ISO_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type IdempotentWriteOutcome<R> =
  | { status: 'ran'; result: R }
  | { status: 'replayed'; result: R | StoredResultTooLarge }
  | { status: 'in_progress' }
  | { status: 'outcome_unknown' };

/** Stored in place of a result too large to keep, so a replay says so instead of returning a cut value. */
export interface StoredResultTooLarge {
  result_not_stored: true;
  /** Serialized size of the original result, in bytes. */
  bytes: number;
  note: string;
}

export interface IdempotentWrite {
  /**
   * Run `fn` at most once per `key` within the TTL. A missing key (an older
   * platform, a tool that did not opt in, a call with no turn) runs `fn`
   * directly, exactly as without the helper.
   */
  run<R>(key: string | null | undefined, fn: () => Promise<R>): Promise<IdempotentWriteOutcome<R>>;
  /** Delete claims past `expires_at`. Safe to call any time. */
  sweep(): Promise<{ deleted: number }>;
}

export interface MakeIdempotentWriteOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration (schema above). */
  table: string;
  /** How long a claim lives. Default 24 h: it only has to outlive the agent's retry. */
  ttlSec?: number;
  /**
   * A `running` claim older than this is treated as a write whose invocation
   * died before it could report. Default 120 s, well past the platform's 25 s
   * write deadline plus the time a Worker keeps running after the caller left.
   */
  staleRunningSec?: number;
  /** Largest result kept for replay, serialized. Default 64 KiB. */
  maxResultBytes?: number;
  /**
   * Decides what a throw from the write means. `true` (the default for every
   * error): nothing landed, release the claim so a real retry runs. `false`:
   * the write may have landed (for example a timeout after the request was
   * sent), so the claim turns `interrupted` and the next repeat answers
   * `outcome_unknown` instead of writing again.
   */
  releaseOnError?: (err: unknown) => boolean;
}

interface ClaimRow {
  state: string;
  result: string | null;
  claimed_at: string;
  expires_at: string;
}

export function makeIdempotentWrite(opts: MakeIdempotentWriteOpts): IdempotentWrite {
  const { db, table } = opts;
  assertIdent(table);
  const ttlSec = opts.ttlSec ?? 24 * 3600;
  const staleRunningSec = opts.staleRunningSec ?? 120;
  const maxResultBytes = opts.maxResultBytes ?? 64 * 1024;
  const releaseOnError = opts.releaseOnError ?? (() => true);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new Error(`idempotent-write: ttlSec must be a positive number, got ${ttlSec}`);
  if (!Number.isFinite(staleRunningSec) || staleRunningSec <= 0) throw new Error(`idempotent-write: staleRunningSec must be a positive number, got ${staleRunningSec}`);

  const changes = (raw: unknown): number => (raw as D1RunResult | null)?.meta?.changes ?? 0;

  async function claim(key: string): Promise<boolean> {
    const now = new Date();
    const raw = await db
      .prepare(`INSERT INTO ${table} (id, state, result, claimed_at, expires_at) VALUES (?, 'running', NULL, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(key, now.toISOString(), new Date(now.getTime() + ttlSec * 1000).toISOString())
      .run();
    return changes(raw) === 1;
  }

  async function execute<R>(key: string, fn: () => Promise<R>): Promise<IdempotentWriteOutcome<R>> {
    let result: R;
    try {
      result = await fn();
    } catch (err) {
      // Only a claim still `running` is touched, never another call's finished one.
      if (releaseOnError(err)) {
        // Nothing landed: release the claim so a real retry can run.
        await db.prepare(`DELETE FROM ${table} WHERE id = ? AND state = 'running'`).bind(key).run();
      } else {
        // It may have landed: the next repeat must check upstream, not write blind.
        await db.prepare(`UPDATE ${table} SET state = 'interrupted' WHERE id = ? AND state = 'running'`).bind(key).run();
      }
      throw err;
    }
    const serialized = JSON.stringify(result ?? null);
    const bytes = new TextEncoder().encode(serialized).length;
    const stored = bytes <= maxResultBytes
      ? serialized
      : JSON.stringify({ result_not_stored: true, bytes, note: `the write succeeded; its result (${bytes} bytes) was too large to keep for replay` } satisfies StoredResultTooLarge);
    await db.prepare(`UPDATE ${table} SET state = 'done', result = ? WHERE id = ?`).bind(stored, key).run();
    return { status: 'ran', result };
  }

  return {
    async run<R>(key: string | null | undefined, fn: () => Promise<R>): Promise<IdempotentWriteOutcome<R>> {
      if (!key) return { status: 'ran', result: await fn() };
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await claim(key)) return execute(key, fn);
        const row = await db
          .prepare(`SELECT state, result, claimed_at, expires_at FROM ${table} WHERE id = ?`)
          .bind(key)
          .first<ClaimRow>();
        // Gone between the insert and the read (a sweep or a released claim): claim again.
        if (!row) continue;
        const nowIso = new Date().toISOString();
        if (row.expires_at <= nowIso) {
          // Expired but not swept yet: it no longer guards anything.
          await db.prepare(`DELETE FROM ${table} WHERE id = ? AND expires_at <= ${NOW_ISO_SQL}`).bind(key).run();
          continue;
        }
        if (row.state === 'done') {
          return { status: 'replayed', result: row.result === null ? (null as R) : (JSON.parse(row.result) as R) };
        }
        if (row.state === 'unknown') {
          // The agent was told the outcome is unknown and to check upstream;
          // this identical attempt is the retry it decided to make. Exactly
          // one caller wins the takeover.
          const took = await db
            .prepare(`UPDATE ${table} SET state = 'running', claimed_at = ? WHERE id = ? AND state = 'unknown'`)
            .bind(nowIso, key)
            .run();
          return changes(took) === 1 ? execute(key, fn) : { status: 'in_progress' };
        }
        if (row.state === 'interrupted') {
          // The write threw in a way that may have landed. Tell this repeat
          // once; the attempt after it is the agent's informed retry.
          await db.prepare(`UPDATE ${table} SET state = 'unknown' WHERE id = ? AND state = 'interrupted'`).bind(key).run();
          return { status: 'outcome_unknown' };
        }
        // running
        const ageMs = Date.parse(nowIso) - Date.parse(row.claimed_at);
        if (ageMs > staleRunningSec * 1000) {
          await db
            .prepare(`UPDATE ${table} SET state = 'unknown' WHERE id = ? AND state = 'running' AND claimed_at = ?`)
            .bind(key, row.claimed_at)
            .run();
          return { status: 'outcome_unknown' };
        }
        return { status: 'in_progress' };
      }
      // Two races in a row: refuse rather than risk a second write.
      return { status: 'in_progress' };
    },

    async sweep() {
      const raw = await db.prepare(`DELETE FROM ${table} WHERE expires_at <= ${NOW_ISO_SQL}`).bind().run();
      return { deleted: changes(raw) };
    },
  };
}

/** The `{ ok: false, error, hint }` refusal an app returns to the agent. */
export interface IdempotentWriteRefusal {
  ok: false;
  error: string;
  hint: string;
}

/**
 * Map an outcome to what a tool handler returns: the result for `ran` and
 * `replayed`, and a plain refusal the agent can act on otherwise. The platform
 * passes `error` and `hint` through to the agent unchanged.
 */
export function idempotentToolResult<R>(outcome: IdempotentWriteOutcome<R>): R | StoredResultTooLarge | IdempotentWriteRefusal {
  switch (outcome.status) {
    case 'ran':
    case 'replayed':
      return outcome.result;
    case 'in_progress':
      return {
        ok: false,
        error: 'write_in_progress: the same write from your earlier attempt is still running',
        hint: 'Do not resend it. Check in a minute whether it completed (for example by reading the record it creates).',
      };
    case 'outcome_unknown':
      return {
        ok: false,
        error: 'write_outcome_unknown: an earlier attempt of this same write stopped before reporting whether it landed',
        hint: 'Check upstream whether it took effect. Resend it only if it did not; the next identical attempt will run.',
      };
  }
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) throw new Error(`idempotent-write: table name "${name}" is not a plain SQL identifier`);
}

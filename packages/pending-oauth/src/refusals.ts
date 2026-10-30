/**
 * Per-install OAuth refusal markers, and the one callback entry point that
 * consults them.
 *
 * `consume` deletes the pending row, so a reload of a callback that was
 * REFUSED after the consume found no row and reported a bad state: the person
 * lost the refusal's hint and saw a generic red page (sprigr-apps#4328,
 * #4331). A refusal marker keeps the refusal so the reload can repeat it.
 *
 * Same rules as the completion markers: keyed by sha-256 of the csrf, read
 * only after `consume` came back empty and after the completion check, and a
 * hit only repeats the refusal. `consumeOAuthCallback` makes the write side
 * structural too: `refuse` exists only for a flow whose pending row was
 * consumed, so a csrf this install never minted cannot write a marker.
 *
 * Table shape (the app owns the migration):
 *   CREATE TABLE <app>_oauth_refusals (
 *     csrf_hash  TEXT PRIMARY KEY,
 *     reason     TEXT NOT NULL,
 *     refused_at INTEGER NOT NULL
 *   );
 *   CREATE INDEX ... ON <app>_oauth_refusals(refused_at);
 *
 * `reason` holds the whole refusal result as JSON, because apps refuse in
 * different shapes (`{ ok, reason }`, `{ ok, error, hint }`). Every operation
 * is best-effort and never throws.
 */

import type { D1Like } from './types';
import { assertIdent } from './store';
import { hashCsrf } from './hash';
import { COMPLETION_TRIM_MS, COMPLETION_WINDOW_MS, type OAuthCompletions } from './completions';

export interface OAuthRefusals<R extends object> {
  /** Remember the refusal for this flow. Never throws. */
  record(csrf: string, refusal: R): Promise<void>;
  /** The refusal recorded for `csrf` within `windowMs`, or null. Never throws. */
  recent(csrf: string, windowMs?: number): Promise<R | null>;
  /** Sweep markers past COMPLETION_TRIM_MS. Never throws. */
  trimExpired(): Promise<void>;
}

export interface MakeOAuthRefusalsOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeOAuthRefusals<R extends object>(opts: MakeOAuthRefusalsOpts): OAuthRefusals<R> {
  const { db, table } = opts;
  assertIdent(table);

  return {
    async record(csrf: string, refusal: R): Promise<void> {
      try {
        await db
          .prepare(`INSERT INTO ${table} (csrf_hash, reason, refused_at) VALUES (?, ?, ?)
       ON CONFLICT(csrf_hash) DO UPDATE SET reason = excluded.reason, refused_at = excluded.refused_at`)
          .bind(await hashCsrf(csrf), JSON.stringify(refusal), Date.now())
          .run();
      } catch (err) {
        console.warn(
          '[oauth-refusals] could not record the refusal marker; a reload of this callback will read as a generic state error:',
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async recent(csrf: string, windowMs: number = COMPLETION_WINDOW_MS): Promise<R | null> {
      try {
        const row = await db
          .prepare(`SELECT reason, refused_at FROM ${table} WHERE csrf_hash = ?`)
          .bind(await hashCsrf(csrf))
          .first<{ reason: string; refused_at: number }>();
        if (!row || Date.now() - Number(row.refused_at) > windowMs) return null;
        return decodeRefusal<R>(row.reason);
      } catch (err) {
        console.warn(
          '[oauth-refusals] refusal lookup failed; falling back to the generic state error:',
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    },

    async trimExpired(): Promise<void> {
      try {
        await db
          .prepare(`DELETE FROM ${table} WHERE refused_at < ?`)
          .bind(Date.now() - COMPLETION_TRIM_MS)
          .run();
      } catch (err) {
        console.warn('[oauth-refusals] sweep failed:', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** A row that is not a JSON object (microsoft-365's app-local store wrote
 *  plain text) reads as `{ reason: <text> }`. */
function decodeRefusal<R>(text: string): R {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as R;
  } catch {
    // plain text, below
  }
  return { reason: text } as R;
}

/** What the callback should do with a presented csrf. */
export type OAuthCallbackOutcome<P, R extends object> =
  /** The pending row was consumed. `refuse` records the refusal and returns it. */
  | { kind: 'consumed'; pending: P; refuse: (refusal: R) => Promise<R> }
  /** A reload of a flow that already completed. Report `already_connected`. */
  | { kind: 'already_connected' }
  /** A reload of a flow this install refused. Return `refusal` as is. */
  | { kind: 'refused'; refusal: R }
  /** Missing, forged, unknown, expired or replayed. The app's own refusal. */
  | { kind: 'unknown' };

export interface ConsumeOAuthCallbackOpts<P, R extends object> {
  csrf: string | null | undefined;
  /** The app's single-use consume (its shim's `consumePendingOAuth`). */
  consume: (csrf: string) => Promise<P | null>;
  completions: Pick<OAuthCompletions, 'wasRecentlyCompleted'>;
  refusals: Pick<OAuthRefusals<R>, 'record' | 'recent'>;
}

/**
 * Consume the pending row, or explain a missing one. A completion beats a
 * refusal: a recorded completion means the connection is real.
 */
export async function consumeOAuthCallback<P, R extends object>(
  opts: ConsumeOAuthCallbackOpts<P, R>,
): Promise<OAuthCallbackOutcome<P, R>> {
  const { csrf, consume, completions, refusals } = opts;
  if (!csrf) return { kind: 'unknown' };

  const pending = await consume(csrf);
  if (pending) {
    return {
      kind: 'consumed',
      pending,
      refuse: async (refusal: R) => {
        await refusals.record(csrf, refusal);
        return refusal;
      },
    };
  }

  if (await completions.wasRecentlyCompleted(csrf)) return { kind: 'already_connected' };
  const refusal = await refusals.recent(csrf);
  if (refusal) return { kind: 'refused', refusal };
  return { kind: 'unknown' };
}

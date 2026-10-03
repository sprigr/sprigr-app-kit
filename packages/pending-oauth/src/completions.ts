/**
 * Per-install OAuth completion markers, table-parameterised.
 *
 * "Did this exact OAuth flow already complete?" is the one question the
 * single-use pending store structurally cannot answer.
 *
 * `consume` deletes the pending row on read, before it even evaluates the
 * TTL, because that is the replay defence. The consequence is that a SECOND
 * delivery of the same callback is indistinguishable from a forged state, an
 * unknown state and an expired one: all four produce a missing row, and a
 * callback that collapses all four into one refusal shows its red "Couldn't
 * complete OAuth" page for what is, overwhelmingly, the benign case: a user
 * re-opening a callback URL, or a browser restoring the tab, for a connection
 * that had already worked.
 *
 * That is not hypothetical. On 2026-09-22 the Australia the Gift
 * microsoft-365 install connected successfully at 05:56:31 (18 scopes, file
 * indexing on, mail backfill running by 05:56:51) and the customer, shown a
 * page that made them doubt it, re-opened the callback at 05:58:14 and was
 * told `invalid_oauth_state: csrf missing, unknown, replayed, or expired`.
 * They reported the connection as broken. It was never broken.
 *
 * The shape every app's `<app>_oauth_completions` table follows:
 *   CREATE TABLE <app>_oauth_completions (
 *     csrf_hash    TEXT PRIMARY KEY,
 *     completed_at INTEGER NOT NULL
 *   );
 *   CREATE INDEX ... ON <app>_oauth_completions(completed_at);
 *
 * Apps pick their own table name and own the migration, exactly as with the
 * pending store.
 *
 * What this does NOT do. It does not weaken the CSRF gate, and the shape is
 * chosen so it cannot:
 *
 *   - The marker is `sha-256(csrf)`, never the csrf. Nothing readable out of
 *     this table can be presented back as state, so a leak grants nothing.
 *   - A marker hit is never a pass. The caller consults it only AFTER the
 *     pending row came back empty, and turns a hit into a REPORTED failure
 *     (`ok:false`, `already_connected`), so no code is exchanged, no token is
 *     written, no actor is bound, nothing mutates. The only thing it changes
 *     is the sentence the user reads. A miss falls through to the app's
 *     existing refusal unchanged.
 *   - It tells an attacker nothing they did not supply. Presenting a random
 *     csrf misses, exactly as before. Presenting one that hits means they
 *     already held the state of a flow that already succeeded, which is what
 *     "I am re-opening my own callback URL" means.
 *   - The pending row's lifetime is untouched. Extending THAT would have
 *     answered the same question by reopening the replay window; this is a
 *     separate table holding a separate fact.
 *
 * Every operation is best-effort. A failed marker write must never fail a
 * good connect, and a failed lookup must fall back to the refusal the app
 * already gives. Losing a marker costs the pre-existing wording, nothing
 * worse.
 */

import type { D1Like } from './types';
import { assertIdent } from './store';

/**
 * How recently a flow must have completed for a replay to be reported as
 * already connected rather than as a bad state.
 *
 * Generous on purpose. The cost of being too generous is that someone who
 * re-opens a genuinely stale link is told they are already connected, and
 * they ARE; the marker only exists because a connect for that csrf succeeded.
 * The cost of being too tight is the red page this exists to remove. An hour
 * covers a reopened tab, a restored browser session, and a user who walks
 * away mid-flow and comes back.
 */
export const COMPLETION_WINDOW_MS = 60 * 60 * 1000;

/** How long a marker physically survives before the sweep drops it. Kept
 *  above the window so a row is never swept while still answerable. */
export const COMPLETION_TRIM_MS = 24 * 60 * 60 * 1000;

export interface OAuthCompletions {
  /**
   * Record that the flow identified by `csrf` completed.
   *
   * Call this as soon as the connection is REAL (the tokens are written), not
   * at the end of the handler. The whole reason a user re-opens the callback
   * URL is that the handler ran long, and a handler that runs long is exactly
   * the one at risk of being cut off before its last line, so a marker
   * written last would be missing in precisely the cases that need it. The
   * 2026-09-22 handler was in fact killed mid-flight, several steps after the
   * tokens landed.
   *
   * Never throws.
   */
  record(csrf: string): Promise<void>;
  /**
   * True when `csrf` names a flow that completed within `windowMs`.
   *
   * Only ever consult this AFTER the pending row came back empty, so it can
   * only ever soften an outcome that was already a refusal. Never throws; a
   * failed lookup reads as `false`.
   */
  wasRecentlyCompleted(csrf: string, windowMs?: number): Promise<boolean>;
  /** Sweep markers past COMPLETION_TRIM_MS. Cheap (index seek + delete); call
   *  it from the same places that trim expired pending rows. Never throws. */
  trimExpired(): Promise<void>;
}

export interface MakeOAuthCompletionsOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeOAuthCompletions(opts: MakeOAuthCompletionsOpts): OAuthCompletions {
  const { db, table } = opts;
  // Same reasoning as the pending store: SQLite cannot parameterise
  // identifiers, and the name comes from the app's own shim, never from
  // user input. Reject anything that isn't a plain identifier anyway.
  assertIdent(table);

  return {
    async record(csrf: string): Promise<void> {
      try {
        await db
          .prepare(`INSERT INTO ${table} (csrf_hash, completed_at) VALUES (?, ?)
       ON CONFLICT(csrf_hash) DO UPDATE SET completed_at = excluded.completed_at`)
          .bind(await hashCsrf(csrf), Date.now())
          .run();
      } catch (err) {
        console.warn(
          '[oauth-completions] could not record the completion marker; a replay of this callback will read as a generic state error:',
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async wasRecentlyCompleted(csrf: string, windowMs: number = COMPLETION_WINDOW_MS): Promise<boolean> {
      try {
        const row = await db
          .prepare(`SELECT completed_at FROM ${table} WHERE csrf_hash = ?`)
          .bind(await hashCsrf(csrf))
          .first<{ completed_at: number }>();
        return !!row && Date.now() - row.completed_at <= windowMs;
      } catch (err) {
        console.warn(
          '[oauth-completions] completion lookup failed; falling back to the generic state error:',
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },

    async trimExpired(): Promise<void> {
      try {
        await db
          .prepare(`DELETE FROM ${table} WHERE completed_at < ?`)
          .bind(Date.now() - COMPLETION_TRIM_MS)
          .run();
      } catch (err) {
        console.warn(
          '[oauth-completions] sweep failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}

async function hashCsrf(csrf: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csrf));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

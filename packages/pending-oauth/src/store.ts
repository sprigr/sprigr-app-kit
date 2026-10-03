/**
 * Per-install pending-OAuth CSRF store, table-parameterised.
 *
 * The shape every app's `<app>_pending_oauth` table follows:
 *   CREATE TABLE <app>_pending_oauth (
 *     csrf       TEXT PRIMARY KEY,
 *     payload    TEXT NOT NULL,
 *     created_at INTEGER NOT NULL
 *   );
 *
 * Apps pick their own table name and own the migrations. The store is
 * structural: it expects the `csrf`, `payload`, `created_at` columns
 * named exactly that.
 *
 * What it is for: the OAuth start route / connect tool mints a random
 * csrf, stashes the actor (and anything else the callback must be able
 * to TRUST) here keyed by that csrf, and carries only the csrf in the
 * observable OAuth `state`. The callback consumes the row by csrf. The
 * state blob is never trusted for identity.
 *
 * Two invariants in `consume` are load-bearing and must not be
 * "tidied":
 *   1. The DELETE runs BEFORE the TTL comparison, so a presented csrf
 *      is burned even when the row has expired. Returning early on an
 *      expired row without deleting it would reopen replay of expired
 *      state.
 *   2. Lookup is PK equality on the full csrf. No prefix matching, no
 *      normalisation, no lowercasing.
 */

import type { D1Like, PendingStateBase } from './types';

/** 24 hours.
 *
 * The clock starts when the AGENT mints the link and posts it into chat,
 * not when the user clicks it, so a short window turned a link opened
 * later in the day into a dead end. Interactive consent runs long on its
 * own too: MFA, org conditional-access prompts, and admin approval each
 * add minutes. The row holds only a random single-use csrf plus the actor
 * identity, so the longer window costs little; the bouncer's own outer
 * state bound (STATE_MAX_AGE_MS) stays the backstop against very-stale
 * replays and is set above this so THIS check is the one users hit.
 * (Shortened windows were seen killing same-day links on a production install,
 * 2026-08-13, which is what settled the value at 24 hours.) */
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingOAuthStore<T extends PendingStateBase> {
  /** Upsert by csrf. Stamps `created_at` with the write clock. */
  store(state: T): Promise<void>;
  /**
   * Single-use consume. Deletes the row BEFORE evaluating the TTL, so a
   * presented csrf is burned even when expired (this is the replay
   * defence, do not reorder). Returns null when the csrf is unknown, the
   * row is older than the window, or the payload will not parse.
   *
   * @param ttlMs overrides the store's default window (microsoft-365
   *              passes its longer admin-consent window here).
   */
  consume(csrf: string, ttlMs?: number): Promise<T | null>;
  /** Opportunistic sweep of rows older than `trimTtlMs`. Cheap. */
  trimExpired(): Promise<void>;
  /** The default consume window, so callers can advertise what they enforce. */
  readonly ttlMs: number;
}

export interface MakePendingOAuthStoreOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
  /** Default consume window. Defaults to DEFAULT_PENDING_TTL_MS (24h). */
  ttlMs?: number;
  /**
   * Trim cutoff. Defaults to `ttlMs`. An app with a second, LONGER
   * consume window must pass that longer value here, or the sweep will
   * delete rows that are still live for the long-window flow.
   */
  trimTtlMs?: number;
}

export function makePendingOAuthStore<T extends PendingStateBase>(
  opts: MakePendingOAuthStoreOpts,
): PendingOAuthStore<T> {
  const { db, table } = opts;
  // Table name comes from the app's own manifest-declared migrations,
  // never from user input. SQLite cannot parameterise identifiers, so
  // direct interpolation is the only option. Reject anything that
  // isn't a plain identifier to keep this safe even when callers get
  // sloppy about constants.
  assertIdent(table);

  const ttlMs = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  const trimTtlMs = opts.trimTtlMs ?? ttlMs;

  // The three SQL strings below keep the exact text (including the
  // continuation-line indentation inside the template literal) that the
  // ten hand-copied per-app stores emitted before this package existed.
  // Several app test suites mock D1 by regex-matching the SQL, so a
  // reflow here is a behaviour change in those suites. Treat any diff
  // to this text as a red flag rather than a formatting nit.
  return {
    ttlMs,

    async store(state: T): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ${table} (csrf, payload, created_at)
         VALUES (?, ?, ?)
       ON CONFLICT(csrf) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
        )
        .bind(state.csrf, JSON.stringify(state), Date.now())
        .run();
    },

    async consume(csrf: string, overrideTtlMs?: number): Promise<T | null> {
      const window = overrideTtlMs ?? ttlMs;
      const row = await db
        .prepare(`SELECT payload, created_at FROM ${table} WHERE csrf = ?`)
        .bind(csrf)
        .first<{ payload: string; created_at: number }>();
      if (!row) return null;
      // Delete on read - pending state is single-use (blocks replay).
      await db.prepare(`DELETE FROM ${table} WHERE csrf = ?`).bind(csrf).run();
      if (Date.now() - row.created_at > window) return null;
      try {
        return JSON.parse(row.payload) as T;
      } catch {
        return null;
      }
    },

    async trimExpired(): Promise<void> {
      const cutoff = Date.now() - trimTtlMs;
      await db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).bind(cutoff).run();
    },
  };
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Also guards the completions table name (./completions). Not re-exported
 *  from the package index. */
export function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `pending-oauth: table name "${name}" is not a plain SQL identifier`,
    );
  }
}

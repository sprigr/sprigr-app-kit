/**
 * Durable, cross-invocation half of the per-actor refresh guard.
 *
 * `ActorRefreshLatch` coalesces concurrent refresh callers that share ONE
 * isolate. That rests on a one-isolate-per-install assumption which
 * sprigr/sprigr-team#7183 measured to be false: schedules dispatch minutes apart
 * and jittered, so the races that matter frequently span DIFFERENT
 * isolates, where a module-scoped Map sees nothing at all.
 *
 * For a provider that ROTATES the refresh token on redeem (simPRO, Gorgias,
 * Xero) that is not a wasted round trip, it is data loss: two invocations
 * redeeming the same stored refresh token spend it twice, the loser's copy
 * is invalidated, and every action on the install starts failing
 * `invalid_grant` until a human reconnects.
 *
 * The durable guard is one row per actor, taken with an expiry-aware
 * compare-and-swap. Ported from the Gorgias app's token module
 * (sprigr/sprigr-apps#1546) so the three vendored consumers stop needing three
 * hand-copies of it, which is the drift that produced issue sprigr/sprigr-apps#543 in the
 * first place.
 *
 * OPTIONAL BY CONSTRUCTION. A consumer that passes no lease config runs
 * the exact code path it ran before this file existed: `ActorRefreshLatch`
 * only reaches any of this when a caller hands it a `RefreshLeaseConfig`.
 */

import type { D1Like, D1RunResult } from './types';

/**
 * How long a lease is held before another caller may take it over.
 *
 * Longer than a worst-case redeem plus persist (one HTTPS round trip to
 * the provider, then the app's token writes), so the lease cannot expire
 * under the winner and let a second redemption through. Short enough that
 * a winner killed mid-redeem, which is isolate eviction and exactly the
 * scenario sprigr/sprigr-team#7183 measured, strands the actor for at most 30
 * seconds rather than for a TTL of minutes.
 */
export const REFRESH_LEASE_TTL_MS = 30_000;

/**
 * The single bounded wait a loser takes, and only when its cached token is
 * genuinely dead. Action dispatch runs against a per-app 5 second budget,
 * so this stays an order of magnitude under it. In the common case the
 * loser waits zero.
 */
export const REFRESH_LEASE_WAIT_MS = 500;

/**
 * A refresh for this actor is already in flight in another invocation, and
 * this caller has nothing usable cached to hand back.
 *
 * Consumers should catch this and rethrow it as their own TRANSIENT auth
 * error, never their terminal / not-connected one: the actor IS connected,
 * a sibling invocation is simply mid-rotation, and telling a connected user
 * to reconnect over a 30 second race would be a lie.
 */
export class RefreshLeaseBusyError extends Error {
  constructor(public readonly actorKey: string) {
    super(
      `A token refresh for ${actorKey} is already in flight in another invocation and no ` +
        `usable cached access token remains. Retry shortly.`,
    );
    this.name = 'RefreshLeaseBusyError';
  }
}

export interface RefreshLeaseConfig<T> {
  /** The app's D1 binding, normally `env.DB`. */
  db: D1Like;
  /**
   * Lease table name, e.g. `simpro_refresh_lease`. The app owns the
   * migration; this package only requires the column shape documented on
   * `refreshLeaseCasSql` below.
   */
  table: string;
  /**
   * Re-read the store and return the actor's tokens IF they are usable
   * RIGHT NOW, else null.
   *
   * Note the deliberate absence of `REFRESH_BUFFER_MS` here: the buffer
   * decides when to START a refresh, and applying it would reject a token
   * with ten perfectly good minutes left. This is the loser's question,
   * which is narrower.
   */
  cachedToken: () => Promise<T | null>;
  /**
   * Called once, best effort, when this caller loses the lease. Intended
   * for the app's `refresh_lease_contended` audit row: that counter is
   * what measures cross-invocation refresh races directly. Errors are
   * swallowed and warned, never propagated.
   */
  onContended?: () => void | Promise<void>;
  /** Override for tests. Defaults to `REFRESH_LEASE_TTL_MS`. */
  ttlMs?: number;
  /** Override for tests. Defaults to `REFRESH_LEASE_WAIT_MS`. */
  waitMs?: number;
  /** Prefix for the diagnostic warnings, e.g. `[simpro-tokens]`. */
  logLabel?: string;
}

/**
 * Expiry-aware compare-and-swap for the per-actor refresh lease.
 *
 * `meta.changes > 0` means acquired: either a fresh insert, or a takeover
 * of a lease whose `expires_at` has already passed. `changes === 0` means
 * another invocation holds a live lease. One statement, atomic, no
 * read-then-write.
 *
 * This is NOT `@sprigr/apps-dedup-latch`'s `tryClaim`, and cannot be.
 * That one is `ON CONFLICT DO NOTHING`, which never honours `expires_at`
 * on acquire: once a row exists it latches until a sweep deletes it.
 * Correct for a dedup latch, fatal for a lease, and the consuming apps
 * declare no sweep schedule for this table, so the first refresh would
 * take the row and no actor would ever refresh again. The shape is the
 * house pattern; only the conflict action differs.
 *
 * Table shape the statement expects (the app owns the migration):
 *
 *   CREATE TABLE <app>_refresh_lease (
 *     actor_key   TEXT PRIMARY KEY,
 *     claimed_at  INTEGER NOT NULL,
 *     expires_at  INTEGER NOT NULL
 *   );
 *
 * Epoch milliseconds, because the comparison is against `Date.now()` in
 * JS. Do not spell it `datetime('now')` like the dedup latch does; mixing
 * the two conventions is how an off-by-a-timezone lands.
 *
 * Exported so a consumer's tests can pin these semantics against a real
 * SQLite engine rather than against an in-memory fake alone.
 */
export function refreshLeaseCasSql(table: string): string {
  assertIdent(table);
  return `INSERT INTO ${table} (actor_key, claimed_at, expires_at)
     VALUES (?1, ?2, ?3)
   ON CONFLICT(actor_key) DO UPDATE SET
     claimed_at = ?2,
     expires_at = ?3
   WHERE ${table}.expires_at <= ?2`;
}

/** The DELETE a winner issues once its token writes have landed. */
export function refreshLeaseReleaseSql(table: string): string {
  assertIdent(table);
  return `DELETE FROM ${table} WHERE actor_key = ?1`;
}

/**
 * True when this caller now holds the refresh lease for `actorKey`.
 *
 * A binding that reports NO `meta.changes` at all counts as ACQUIRED, not
 * as lost, and warns. Absent is not zero: zero is a real, atomic "somebody
 * else holds it", while absent means the driver told us nothing, and
 * guessing "lost" there is the one failure mode that is strictly worse
 * than having no lease. Nobody would ever hold it, so nobody would ever
 * redeem, every actor's refresh token would age out, and the install would
 * land on exactly the invalid_grant this table exists to prevent. Guessing
 * "acquired" degrades to the pre-lease behaviour instead, which is the
 * same fail-open trade `withRefreshLease` makes on an acquire that throws.
 */
export async function tryAcquireRefreshLease(
  db: D1Like,
  table: string,
  actorKey: string,
  ttlMs: number = REFRESH_LEASE_TTL_MS,
  logLabel = '[actor-token-refresh]',
): Promise<boolean> {
  const now = Date.now();
  const raw = await db
    .prepare(refreshLeaseCasSql(table))
    .bind(actorKey, now, now + ttlMs)
    .run();
  const changes = (raw as D1RunResult | null)?.meta?.changes;
  if (changes == null) {
    console.warn(
      `${logLabel} refresh lease acquire for ${actorKey} returned no meta.changes; ` +
        `treating it as acquired (fail open). The DB binding is not reporting row counts.`,
    );
    return true;
  }
  return changes > 0;
}

/**
 * Release the lease. Best effort, never throws: a lost DELETE costs at
 * most one TTL of extra serialisation for this one actor, because the CAS
 * takes an expired lease over anyway.
 */
export async function releaseRefreshLease(
  db: D1Like,
  table: string,
  actorKey: string,
  opts: { ttlMs?: number; logLabel?: string } = {},
): Promise<void> {
  try {
    await db.prepare(refreshLeaseReleaseSql(table)).bind(actorKey).run();
  } catch (err) {
    console.warn(
      `${opts.logLabel ?? '[actor-token-refresh]'} refresh lease release failed for ${actorKey} ` +
        `(it expires in ${opts.ttlMs ?? REFRESH_LEASE_TTL_MS}ms regardless): ${messageOf(err)}`,
    );
  }
}

/**
 * Run `refresh` for `actorKey` under the durable lease.
 *
 * Winner: redeems, and releases STRICTLY after `refresh` resolves. Apps
 * persist the rotated refresh token inside `refresh`, and their write
 * order is load-bearing, so releasing any earlier would let a second
 * invocation redeem a token this one has already spent.
 *
 * Loser: NEVER redeems. Ladder, first hit wins:
 *   1. Re-read the store. If the winner has already persisted, or the old
 *      cached token simply has not expired yet, return it. Zero wait, and
 *      this is the common case: `REFRESH_BUFFER_MS` starts a refresh five
 *      minutes before actual expiry, so when the winner takes the lease
 *      the cached token is normally still good for minutes.
 *   2. Otherwise the token is genuinely dead. One bounded wait, re-read
 *      once, return it if usable.
 *   3. Otherwise throw `RefreshLeaseBusyError`, retryably. Blocking on the
 *      winner would blow the dispatch budget, which is what this design
 *      refuses to do.
 *
 * FAILS OPEN. A lease is a race narrower, not an availability dependency:
 * if the acquire throws (a D1 blip, or an install that has not applied the
 * lease migration yet) the refresh proceeds exactly as it did before this
 * guard existed. Breaking every tenant's connection to avoid a rare
 * double-redeem would be the worse trade.
 */
export async function withRefreshLease<T>(
  actorKey: string,
  refresh: () => Promise<T>,
  cfg: RefreshLeaseConfig<T>,
): Promise<T> {
  const ttlMs = cfg.ttlMs ?? REFRESH_LEASE_TTL_MS;
  const label = cfg.logLabel ?? '[actor-token-refresh]';

  let holdsLease = true;
  try {
    holdsLease = await tryAcquireRefreshLease(cfg.db, cfg.table, actorKey, ttlMs, label);
  } catch (err) {
    console.warn(
      `${label} refresh lease acquire failed for ${actorKey}; proceeding without it: ` +
        `${messageOf(err)}`,
    );
  }

  if (!holdsLease) {
    if (cfg.onContended) {
      try {
        await cfg.onContended();
      } catch (err) {
        console.warn(`${label} refresh lease contention hook failed: ${messageOf(err)}`);
      }
    }
    return tokenWhileAnotherCallerRefreshes(actorKey, cfg);
  }

  try {
    return await refresh();
  } finally {
    await releaseRefreshLease(cfg.db, cfg.table, actorKey, { ttlMs, logLabel: label });
  }
}

async function tokenWhileAnotherCallerRefreshes<T>(
  actorKey: string,
  cfg: RefreshLeaseConfig<T>,
): Promise<T> {
  const immediate = await cfg.cachedToken();
  if (immediate != null) return immediate;

  await new Promise((resolve) => setTimeout(resolve, cfg.waitMs ?? REFRESH_LEASE_WAIT_MS));

  const afterWait = await cfg.cachedToken();
  if (afterWait != null) return afterWait;

  throw new RefreshLeaseBusyError(actorKey);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `actor-token-refresh: lease table name "${name}" is not a plain SQL identifier`,
    );
  }
}

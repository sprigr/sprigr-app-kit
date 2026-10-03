/**
 * @sprigr/apps-actor-token-refresh
 *
 * The per-actor "is this token fresh, and if not, who refreshes it" protocol
 * shared by every OAuth-integrated marketplace app: refresh this many ms
 * before actual expiry (`REFRESH_BUFFER_MS`), and coalesce concurrent
 * `getFreshAccessToken` calls for the same actor onto one in-flight Promise
 * (`ActorRefreshLatch`) so a fan-out of agent actions doesn't hit the
 * provider's token endpoint N times — and, for rotating-refresh-token
 * providers, doesn't race two rotations against each other and strand one
 * of the new refresh tokens.
 *
 * Extracted from three hand-copies (google-search-console, simpro,
 * xero-accounting) that had the same latch/buffer/protocol but were
 * drifting — issue sprigr/sprigr-apps#543. Each app keeps its own token shape, its own
 * auth-error class (so `instanceof` checks in handlers keep working) and
 * its own resolution logic (business/tenant selection, alternate auth
 * methods, etc.); only the generic freshness check and the in-flight latch
 * live here.
 *
 * The latch alone only coalesces callers that share ONE isolate, which
 * sprigr/sprigr-team#7183 measured to be a false assumption for scheduled
 * dispatch. `refresh-lease.ts` adds the durable, cross-invocation half:
 * an OPTIONAL per-actor D1 row, off unless a caller passes a
 * `RefreshLeaseConfig` to `ActorRefreshLatch.run`, so a consumer that has
 * not adopted it behaves exactly as before (sprigr/sprigr-apps#1547).
 */

import { withRefreshLease, type RefreshLeaseConfig } from './refresh-lease';

export {
  REFRESH_LEASE_TTL_MS,
  REFRESH_LEASE_WAIT_MS,
  RefreshLeaseBusyError,
  refreshLeaseCasSql,
  refreshLeaseReleaseSql,
  releaseRefreshLease,
  tryAcquireRefreshLease,
  withRefreshLease,
} from './refresh-lease';
export type { RefreshLeaseConfig } from './refresh-lease';
export type { D1Like, D1PreparedStatementLike, D1RunResult } from './types';

/** Refresh this many ms before actual expiry so the token is comfortably
 *  fresh when the API call goes out. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** The minimal shape `needsRefresh` reads off a stored token row. */
export interface RefreshableTokenFields {
  access_token: string | null;
  expires_at: number | null;
}

export interface NeedsRefreshOpts {
  /** Skip the freshness check and always report a refresh is needed. */
  force?: boolean;
}

/**
 * True when `tokens` needs a refresh: forced, no access token stored yet,
 * no known expiry, or within `REFRESH_BUFFER_MS` of (or past) expiry.
 */
export function needsRefresh(tokens: RefreshableTokenFields, opts: NeedsRefreshOpts = {}): boolean {
  return (
    !!opts.force ||
    !tokens.access_token ||
    tokens.expires_at == null ||
    tokens.expires_at - Date.now() < REFRESH_BUFFER_MS
  );
}

/** Canonical message for the "actor has a token row but no usable key to
 *  latch on" failure — neither platformUserId nor agentId resolved. Each
 *  app throws this text via its own auth-error class (so callers can keep
 *  doing `instanceof GoogleAuthError` etc.); only the wording is shared, so
 *  it can't drift between apps the way three hand-typed copies did. */
export const ACTOR_KEY_MISSING_MESSAGE = 'actor missing both platformUserId and agentId';

/**
 * Per-actor in-flight latch. Two concurrent callers for the same key share
 * one in-progress refresh Promise: the winner performs (and persists) the
 * refresh, the loser resolves off that same Promise instead of hitting the
 * provider's token endpoint again.
 *
 * Instantiate one latch per token type at module scope in the consuming
 * app, so it's shared across requests within one isolate for the isolate's
 * whole lifetime — matching the WFP one-isolate-per-install execution model.
 */
export class ActorRefreshLatch<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * Run `refresh` for `key`, coalescing concurrent callers onto one
   * Promise. `refresh` is only invoked when no refresh for `key` is
   * already in flight.
   *
   * `lease` is OPTIONAL and off by default. Without it this method is
   * exactly what it always was: an in-isolate latch, and nothing here
   * touches D1. With it, the caller that reaches the provider must also
   * win a durable per-actor row first, so the guard survives the
   * cross-isolate case a module-scoped Map cannot see (sprigr/sprigr-apps#1547,
   * sprigr/sprigr-team#7183). See `refresh-lease.ts` for the full protocol; a
   * consumer that adopts it must also ship the lease table's migration.
   */
  run(key: string, refresh: () => Promise<T>, lease?: RefreshLeaseConfig<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // The in-isolate latch stays the OUTER guard, deliberately: it costs
    // nothing, and it means at most one caller per isolate ever spends a
    // D1 round trip on the lease.
    const promise = (lease ? withRefreshLease(key, refresh, lease) : refresh()).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

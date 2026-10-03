# @sprigr/apps-actor-token-refresh

The per-actor OAuth token-freshness protocol shared by every OAuth-integrated
marketplace app: a `REFRESH_BUFFER_MS` constant, a `needsRefresh` freshness
check, and an `ActorRefreshLatch` that coalesces concurrent
`getFreshAccessToken` calls for the same actor onto one in-flight refresh.

Extracted from three hand-copies (`google-search-console`, `simpro`,
`xero-accounting`) that carried the same latch/buffer/protocol but were
drifting apart — any protocol fix had to be applied three times by hand
(issue sprigr/sprigr-apps#543). Each app keeps its own token row shape, its own auth-error
class, and its own resolution logic (business/tenant selection, alternate
auth methods, etc.); only the generic freshness check and the in-flight
latch live here.

Depend on the published package at an exact version
(`"@sprigr/apps-actor-token-refresh": "0.1.0"`) and import it by name. It has
no runtime dependencies.

## Usage

```ts
import { REFRESH_BUFFER_MS, needsRefresh, ActorRefreshLatch, ACTOR_KEY_MISSING_MESSAGE } from '@sprigr/apps-actor-token-refresh';

const refreshLatch = new ActorRefreshLatch<MyActorTokens>();

async function ensureFreshTokens(env, actor, tokens, opts = {}) {
  if (!needsRefresh(tokens, opts) && tokens.access_token) return tokens;

  const key = actorKey(actor);
  if (!key) throw new MyAuthError(true, 0, ACTOR_KEY_MISSING_MESSAGE);

  return refreshLatch.run(key, () => doRefresh(env, actor, tokens));
}
```

## Optional: the durable cross-invocation lease

The latch above coalesces callers that share ONE isolate. sprigr/sprigr-team#7183
measured that assumption to be false for scheduled dispatch: schedules fire
minutes apart and jittered, so the races that matter frequently span
different isolates, where a module-scoped Map sees nothing at all. For a
provider that ROTATES the refresh token on redeem (simPRO, Gorgias, Xero)
that is data loss, not a wasted round trip: two invocations spend the same
stored refresh token, the loser's copy is invalidated, and every action on
the install fails `invalid_grant` until a human reconnects
(sprigr/sprigr-apps#1547, ported from the Gorgias app's token module in sprigr/sprigr-apps#1546).

Pass a `RefreshLeaseConfig` as `run`'s third argument to add the durable
half. It is **off by default**: a consumer that passes nothing runs the
exact code path it ran before this layer existed and never touches D1.

The app owns the migration:

```sql
CREATE TABLE <app>_refresh_lease (
  actor_key   TEXT PRIMARY KEY,
  claimed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
```

Epoch milliseconds, because the comparison is against `Date.now()`. No
sweep and no index: one row per actor, taken over in place by an
expiry-aware upsert, so the row count is bounded by the actor count, and an
expired row is not garbage but exactly what the takeover path needs.

```ts
return refreshLatch.run(key, () => doRefresh(env, actor, tokens), {
  db: env.DB,
  table: 'myapp_refresh_lease',
  logLabel: '[myapp-tokens]',
  // Usable RIGHT NOW, deliberately without REFRESH_BUFFER_MS: the buffer
  // decides when to START a refresh, not whether a token still works.
  cachedToken: async () => {
    const fresh = await loadActorTokens(env.DB, actor);
    return fresh?.access_token && (fresh.expires_at ?? 0) > Date.now() ? fresh : null;
  },
  // The counter that measures cross-invocation races directly.
  onContended: () => auditRefreshLeaseContended(env, actor),
});
```

A caller that loses the lease NEVER redeems. It re-reads the store, returns
a still-usable cached token immediately, otherwise takes one bounded
`REFRESH_LEASE_WAIT_MS` wait and re-reads, otherwise throws
`RefreshLeaseBusyError`. Catch that and rethrow it as your app's
**transient** auth error, never its terminal / not-connected one: the actor
is connected, a sibling invocation is simply mid-rotation.

Acquire failures **fail open** (a D1 blip, or an install that has not
applied the migration yet, must not break the tenant's connection), and
release failures are warned, not thrown, because the CAS takes an expired
lease over anyway.

# @sprigr/apps-oauth-utils

Race-safe OAuth refresh-token rotation utilities for apps in this repo.

**Empty today.** Seeded at the start of P1 from `packages/auth/src/simpro.ts` in sprigr-team. That implementation has months of hardening around:

- Persist new refresh_token BEFORE discarding old (rotation safety)
- Single-flight refresh deduplication (concurrent handler calls don't double-refresh)
- KV-based lock with short TTL for cross-request coordination
- Terminal vs transient error classification (revoked tokens flag the integration as disconnected; 5xx retries)
- 5-minute expiry buffer before considered "expired"

Do not re-derive any of this. Copy, adapt the provider-specific endpoints + response shapes, and keep the race logic intact.

## Failure messages never carry the provider's raw body (0.2.0)

`exchangeAuthCode` and `refreshOAuthToken` build `OAuthError.message` with
`describeOAuthFailure`, from the provider, the operation, the HTTP status, the
terminal/transient classification and the two spec-defined body fields
(`error`, `error_description`). The raw response body is never interpolated.

A token endpoint's error body is provider-controlled and routinely echoes back
the request that failed, so it can contain the authorization `code`, the
`client_secret` or the `refresh_token`. Apps write `err.message` into durable
per-install audit columns, and several read those columns back to an agent tool
caller or render them on the app's settings page.

A body that is not OAuth-shaped JSON is withheld, and the message says so and
gives its byte length, so the omission is visible rather than silent:

```
google token refresh failed (400); reason=unknown; provider body withheld
  (412 bytes, not OAuth JSON; raw bodies can carry credentials and this
  string is persisted)
```

`classifyOAuthError` returns the same `terminal` / `reason` as before plus
`errorCode`, `errorDescription`, `unparsed` and `bodyLength`. Destructuring
callers are unaffected. The full body is still available at the call site if you
want it in a console log, which is not a durable store.

Ported from sprigr/sprigr-apps#560 (PR sprigr/sprigr-apps#1453); tracked here as
#41.

## Bounding the refresh fetch: `timeoutMs` (0.3.0)

`ProviderConfig.timeoutMs` is an optional bound on the token-endpoint fetch
that `refreshOAuthToken` (and so `refreshAndPersist` and `getValidAccessToken`)
makes. When set, the request carries `AbortSignal.timeout(timeoutMs)` and a
provider that never answers rejects with the runtime's `AbortError` instead of
holding the invocation until the platform kills it. The rotation-race retry
gets its own fresh bound.

It is unset by default, so existing callers keep the unbounded behaviour. Set it
on scheduled paths (a cron that refreshes every actor's token), where one hung
provider can spend the whole invocation budget. Leave it unset on interactive
and agent paths, where a merely slow provider should still succeed.

**Not for providers that rotate the refresh token on every refresh.** The abort
cancels the request, and it can land after the provider has already rotated.
The old refresh token is then invalid, the new one is in a response nobody
reads, and the install needs a reconnect. For a rotating provider, bound only
the caller's wait instead: race the refresh promise against a timer, and hand
the refresh itself to `ctx.waitUntil` so the isolate stays alive until the new
token is persisted. The ServiceM8 app in sprigr-apps does exactly this for its
scheduled refresh.

```ts
const config: ProviderConfig = { ...baseConfig, timeoutMs: 10_000 };
await refreshAndPersist(config, store, prefix, false);
```

## Revoking the grant on uninstall: `revokeOnUninstall` (0.4.0)

Deleting stored tokens does not end a grant: the provider honours it until it
expires. Revoke it in your `on_uninstall` hook, which runs before the platform
purges the install's secrets, so the tokens are still readable
([decision 0001](../../docs/decisions/0001-revoke-provider-grants-on-uninstall.md)).

```ts
import { revokeOnUninstall, googleRevoker } from '@sprigr/apps-oauth-utils';

const started = Date.now();
const rows = await listActorTokens(env.DB); // your own table
const { revoked, failed, notReached } = await revokeOnUninstall({
  targets: rows.map((r) => ({ token: r.refreshToken, accountKey: r.email })),
  revoker: googleRevoker,
  deadlineAt: started + 12_000, // the hook gets 15 s; leave time to delete rows
});
// then delete the rows whatever the outcome, and record the counts
```

- **One revoke per account.** Rows with the same `accountKey` send one revoke;
  the rest wait for its answer and send their own token only if it failed.
- **Bounded.** At most `concurrency` (4) in flight, each cut at `timeoutMs`
  (5000) with its `signal` aborted, and none started with less than `timeoutMs`
  left before `deadlineAt`.
- **Never throws, never returns a token.** A revoker that throws, times out
  or answers false counts as `failed`.

Revokers: `googleRevoker`, `asanaRevoker({ clientId, clientSecret })`, and
`formPostRevoker(url, params)` for any endpoint that takes `token` as a form
POST. A `ProviderRevoker` is `(token, { signal }) => Promise<boolean>`: true
only when the provider confirmed it.

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

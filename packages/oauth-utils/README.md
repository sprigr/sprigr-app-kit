# @sprigr/apps-oauth-utils

Race-safe OAuth refresh-token rotation utilities for apps in this repo.

**Empty today.** Seeded at the start of P1 from `packages/auth/src/simpro.ts` in sprigr-team. That implementation has months of hardening around:

- Persist new refresh_token BEFORE discarding old (rotation safety)
- Single-flight refresh deduplication (concurrent handler calls don't double-refresh)
- KV-based lock with short TTL for cross-request coordination
- Terminal vs transient error classification (revoked tokens flag the integration as disconnected; 5xx retries)
- 5-minute expiry buffer before considered "expired"

Do not re-derive any of this. Copy, adapt the provider-specific endpoints + response shapes, and keep the race logic intact.

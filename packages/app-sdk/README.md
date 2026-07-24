# @sprigr/apps-app-sdk

Shared handler types + helpers for apps in this repo.

Scaffold today: just the type contracts the Sprigr wrapper expects. P1 adds:

- `fetchWithRetry` (rate-limit-header-aware, jittered retry)
- `constantTimeEqual(a, b)` for bearer-secret verification
- `encodeState` / `decodeState` for OAuth state base64url
- Anything else extracted from `apps/procore` once it stabilises

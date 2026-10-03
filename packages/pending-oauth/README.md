# `@sprigr/apps-pending-oauth`

Single-use, TTL'd pending-OAuth CSRF state in a per-install D1 table.

Ten marketplace apps each carried a hand-copied version of this store. The
copies had drifted in field sets and stale comments (issue sprigr/sprigr-apps#544). The
mechanism now lives here once, parameterised by table name; each app keeps
its own table and its own payload shape.

## Table shape

Apps own the migration. The store expects exactly these columns:

```sql
CREATE TABLE <app>_pending_oauth (
  csrf       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## Use

Depend on the published package at an exact version:

```json
{ "dependencies": { "@sprigr/apps-pending-oauth": "0.1.0" } }
```

Then wire it up in `src/lib/pending-oauth.ts`, which pins the table name
and the payload type and re-exports the three functions the call sites
already use:

```ts
import type { D1Like } from '@sprigr/apps-app-sdk';
import { makePendingOAuthStore, DEFAULT_PENDING_TTL_MS } from '@sprigr/apps-pending-oauth';

export const PENDING_TTL_MS = DEFAULT_PENDING_TTL_MS;

export interface PendingState {
  csrf: string;
  actorPlatformUserId: string | null;
  actorAgentId: string | null;
  iat: number;
}

const store = (db: D1Like) =>
  makePendingOAuthStore<PendingState>({ db, table: 'myapp_pending_oauth' });

export const storePendingOAuth = (db: D1Like, state: PendingState): Promise<void> =>
  store(db).store(state);
export const consumePendingOAuth = (db: D1Like, csrf: string): Promise<PendingState | null> =>
  store(db).consume(csrf);
export const trimExpiredPending = (db: D1Like): Promise<void> => store(db).trimExpired();
```

## Completion markers (second table, required)

Because `consume` deletes on read, a second delivery of a callback whose
connect already WORKED looks exactly like a forged, unknown or expired
state. Users re-open callback URLs and browsers restore tabs, so that
benign case is the common one, and a refusal page there makes people
believe a working connection is broken (microsoft-365, 2026-09-22).
`makeOAuthCompletions` records `sha-256(csrf)` when a connect succeeds, so
the callback can report `already_connected` instead.

Every app that uses this package should wire them. The platform's
OAuth bouncer shows its "already connected" page only for a callback result
with `ok: false` and `reason: 'already_connected'`; any other shape keeps
the red failure page.

The app adds its own table in a new migration:

```sql
CREATE TABLE IF NOT EXISTS myapp_oauth_completions (
  csrf_hash    TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_myapp_oauth_completions_at
  ON myapp_oauth_completions(completed_at);
```

and wires it in the same `src/lib/pending-oauth.ts` shim:

```ts
import { makeOAuthCompletions } from '@sprigr/apps-pending-oauth';

const completions = (db: D1Like) =>
  makeOAuthCompletions({ db, table: 'myapp_oauth_completions' });

export const recordOAuthCompletion = (db: D1Like, csrf: string): Promise<void> =>
  completions(db).record(csrf);
export const wasRecentlyCompleted = (db: D1Like, csrf: string, windowMs?: number): Promise<boolean> =>
  completions(db).wasRecentlyCompleted(csrf, windowMs);
export const trimExpiredCompletions = (db: D1Like): Promise<void> => completions(db).trimExpired();
```

In the callback: call `recordOAuthCompletion` as soon as the tokens are
written (not at the end of the handler, which is the part that gets cut
off), consult `wasRecentlyCompleted` ONLY after `consumePendingOAuth`
returned null, and turn a hit into a reported failure (`ok: false`,
`already_connected`) with no exchange and no write. A miss must fall
through to the app's existing refusal unchanged. Trim alongside
`trimExpiredPending`.

Why this cannot weaken the csrf gate: only the hash is stored, so nothing
in the table can be presented back as state; a hit never grants anything;
and the pending row's lifetime is untouched. Every operation is
best-effort and never throws. The answer window is 1 hour
(`COMPLETION_WINDOW_MS`) and markers are swept after 24 hours
(`COMPLETION_TRIM_MS`). The full reasoning is in `src/completions.ts`.

## Two things not to "tidy"

1. **`consume` deletes the row BEFORE comparing the TTL.** A presented
   csrf is burned even when the row has already expired. Returning early
   on an expired row without deleting it reopens replay of expired state.
2. **An app with a second, longer consume window must pass `trimTtlMs`.**
   microsoft-365 consumes admin-consent rows at 7 days; trimming at the
   24h default would delete live admin-consent rows out from under the IT
   admin.

/**
 * @sprigr/apps-pending-oauth
 *
 * Single-use, TTL'd OAuth handshake state in a per-install D1 table with
 * the shape `(csrf TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at
 * INTEGER NOT NULL)`.
 *
 *   `makePendingOAuthStore` - a store bound to one app's table name and
 *                             one app's payload type.
 *   `makeOAuthCompletions`  - optional sha-256 completion markers in a
 *                             second table, so a replayed callback of a
 *                             connect that already worked can be told
 *                             apart from a bad state.
 *
 * Apps pick their own table names and own the migrations. An app wires it
 * up in `src/lib/pending-oauth.ts`, which pins the table literals and the
 * payload shape and re-exports `storePendingOAuth` /
 * `consumePendingOAuth` / `trimExpiredPending` (plus, for apps with a
 * completions table, `recordOAuthCompletion` / `wasRecentlyCompleted` /
 * `trimExpiredCompletions`) so call sites never see this package directly.
 */

export { makePendingOAuthStore, DEFAULT_PENDING_TTL_MS } from './store';
export type { PendingOAuthStore, MakePendingOAuthStoreOpts } from './store';

export { makeOAuthCompletions, COMPLETION_WINDOW_MS, COMPLETION_TRIM_MS } from './completions';
export type { OAuthCompletions, MakeOAuthCompletionsOpts } from './completions';

export type { D1Like, D1PreparedStatementLike, PendingStateBase } from './types';

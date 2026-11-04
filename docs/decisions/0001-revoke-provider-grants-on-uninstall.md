# 0001: Apps revoke provider grants in `on_uninstall`

Status: proposed (sprigr-team#13941)

## Context

Uninstalling an app removes everything the platform holds for it. The secrets are purged, and since sprigr-team#14006 the scripts that hold the install's key-encryption key are deleted too. The provider tokens left in the install's D1 can no longer be read.

The grant at the provider is a separate thing. A refresh token Sprigr can no longer read is still valid at the provider until it expires or the user removes the app there, and many providers set no fixed expiry on a refresh token. An audit of sprigr-apps on 2026-11-04 (on sprigr-team#13941) found only 4 of 28 token-holding apps revoking at the provider on uninstall: xero-accounting, quickbooks, dropbox and google-workspace. Five more have a Google revoke URL in their own code but never call it at uninstall.

## Decision

An app that holds an OAuth grant revokes it in its `on_uninstall` hook. It uses `revokeOnUninstall` from `@sprigr/apps-oauth-utils` with a `ProviderRevoker` for its provider.

- **Inside the app, not the platform.** The hook already runs before teardown, while the tokens are still readable (`lifecycle-dispatch.ts`). Only the app knows its token table and its provider's endpoint, and a platform-side revoke would need both.
- **Bounded.** The platform gives the hook 15 s and then uninstalls regardless. The runner starts no revoke it cannot finish before `deadlineAt`, and cuts each revoke at `timeoutMs`. A provider that does not answer costs the user nothing: the uninstall still completes, and the grant expires as it does today.
- **Best effort, reported as counts.** `{ revoked, failed, notReached }`, never a token. The app records the counts as it records any hook outcome.
- **One revoke per provider account.** Rows sharing an `accountKey` send one revoke. That is the google-workspace pattern, where every actor row on one Google account shares a grant.

## Alternatives rejected

- **A platform-side revoke after the hook.** The platform would have to learn every app's token schema and every provider's endpoint, which is the app/platform coupling we avoid. It would also run after the secret purge, when the tokens can no longer be read.
- **Rely on expiry.** Many refresh tokens have no fixed expiry, and an uninstalled app should not keep access the user believes they removed.
- **One bespoke revoke per app.** That is the current state: four copies, each with its own timeout and concurrency handling, and the other apps have none.

## Consequences

- An uninstall now makes outbound calls to the provider from the app's worker, inside the hook's existing 15 s. The platform side does not change.
- Each provider needs a revoker. This release ships `googleRevoker` and `asanaRevoker`, plus `formPostRevoker` for the common form-POST shape. Others are added as each provider's endpoint is confirmed. Some providers, Trello for one, document none.
- A revoke that fails or is not reached leaves the grant as it is today. It does not block the uninstall.

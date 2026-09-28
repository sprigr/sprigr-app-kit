# @sprigr/apps-acl-identity-link

Tell the platform which provider account a connection belongs to, so the owner can find their own files in an app's doc-ACL index.

```bash
npm install @sprigr/apps-acl-identity-link   # exact-pin it, like every @sprigr/apps-* package
```

## The problem it solves

An app that indexes a connected account's files (Drive, OneDrive, SharePoint) writes each row to its `-acl-files` index with `acl_principals` such as `user:<connected_email>`, the provider account the connection belongs to. The platform identifies a searcher by their Sprigr login. When that login is a different address from the connected account, the owner's search key never matches, and they see none of their own private files.

`env.SPRIGR.acl.linkIdentity(owner, email)` records "this owner is also this address", on this install's index only. This package wraps it with the parts every app gets wrong the first time: owner selection, email normalisation, a per-isolate memo, and never failing an indexing run over it.

## Usage

```ts
import { recordAclIdentityLink, removeAclIdentityLink } from '@sprigr/apps-acl-identity-link';

// Each indexing run, once you know the connected account's address:
await recordAclIdentityLink(env, actor, connection.email);

// When the connection is removed (omit the email to drop every account the owner linked):
await removeAclIdentityLink(env, actor, connection.email);
```

- **Owner**: the actor's `platformUserId` when the agent is bound to a human, else its `agentId`. `aclOwnerForActor(actor)` exposes the rule.
- **Normalised**: the email is trimmed and lowercased, matching how `user:` principals are written.
- **Idempotent and cheap**: the platform writes only on a miss, and a per-isolate memo skips the call on a hot isolate, so calling it every run is fine. Existing connections backfill on their next run.
- **Best-effort**: a platform error is logged (`[acl-identity-link] ...`) and swallowed. The owner keeps seeing only public files until the next run; the run itself never fails.
- **Older build-runners**: when `env.SPRIGR.acl` is absent, both calls are no-ops.

Tests that assert the call count should call `resetAclIdentityLinkMemoForTests()` in `beforeEach`.

## Types

The package has no runtime dependencies and is typed structurally. Your own env type and `@sprigr/apps-app-sdk`'s `Actor` are assignable as-is:

```ts
interface AclIdentityEnv {
  SPRIGR?: { acl?: AclIdentityBridge };
}
interface AclIdentityBridge {
  linkIdentity?(owner: AclOwner, email: string): Promise<unknown>;
  unlinkIdentity?(owner: AclOwner, email?: string): Promise<unknown>;
}
type AclOwner = { kind: 'user' | 'agent'; id: string };
interface AclActor { agentId?: string; platformUserId?: string }
```

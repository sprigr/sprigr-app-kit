# @sprigr/apps-file-indexing

The shared file-indexing loop for marketplace apps that mirror a cloud drive into the platform's ACL-enforced file index (`<companyId>-app-<slug>-acl-files`). microsoft-365 (OneDrive and SharePoint), google-workspace (Google Drive) and dropbox use it. The design and the alternatives it replaced are in sprigr-team decision 0151 (`docs/decisions/proposed/0151-cloud-storage-apps-share-one-file-indexing-package-behind-a-file-source-adapter.md`).

```bash
npm install @sprigr/apps-file-indexing   # exact-pin it, like every @sprigr/apps-* package
```

`@sprigr/apps-app-sdk` is a **peer** dependency (`>=0.14.0 <1`), so the package runs on the app's own SDK copy and the app's bundle carries one SDK, not two. Keep `@sprigr/apps-app-sdk` (0.14.0 or later) in the app's own `dependencies`, which every app already does. 0.1.0 pinned the SDK at exactly 0.14.0 as a regular dependency, so an app on 0.15 shipped both copies.

An app supplies two things:

- a **`FileSourceAdapter`**: the provider calls (list changes, walk the tree, read permissions, download bytes);
- a **`FileIndexingStore`**: durable state. `createD1FileIndexingStore` builds one over the app's own D1 tables, with the table and column names as config, so existing immutable migrations keep working.

The package owns everything that must behave the same for every provider:

| Concern | What the package guarantees |
|---|---|
| Principal grammar | `user:` / `group:` / `org:` / `public`, byte-identical to the platform (`__tests__/doc-acl-platform-parity.test.ts`, a fixture generated from sprigr-team `packages/shared/src/utils/doc-acl.ts`) |
| Fail closed | A file whose permissions cannot be read is skipped, never stamped `public`. A row whose principals do not validate is never sent, so one bad row cannot reject a whole batch |
| Cursor discipline | The cursor moves only after its rows are imported, seen IDs recorded, deletions applied and events emitted. Any failure keeps the old cursor |
| Unreadable permissions | A transient permission failure holds the cursor at that page so the file is retried (sprigr-apps#2419), bounded by `MAX_UNRESOLVED_HOLD_MS` |
| Content | Text-like files up to 256 KB, native exports, and PDF/OOXML through the platform extract bridge (5 per pass, staged under random single-use keys); pptx and files of 16 MiB or more drain as durable jobs. Text is capped at 32000 chars, and a cut is logged and marked |
| Reconcile | A completed full walk deletes index rows the walk did not see (diff of `data.listIds`, never on uncertainty) |
| Events | `<prefix>.file.created/updated/deleted` on incremental passes, with no per-run cap (sprigr-apps#2521). Pages are emitted in order, but the events WITHIN a page go out with bounded concurrency (`DEFAULT_FETCH_CONCURRENCY`, 6), so their order is not guaranteed; a subscriber that cares orders by `modifiedAt` |
| Disconnect | `purgeActor` switches indexing off, unlinks the owner identity and deletes the scope's rows (sprigr-apps#2355) |
| Sharing-only changes | Opt-in `refreshAclPrincipals` re-stamps `acl_principals` with `data.partialUpdate({ withAcl: true })`, leaving content alone (sprigr-apps#2211) |
| Budgets | Every loop stops STARTING work at its deadline, so every cut lands on a resume point under the 110 s dispatch wall |

## A tick

```ts
import {
  createD1FileIndexingStore,
  createDeadline,
  drainPendingExtractions,
  fileActorStillConnected,
  indexActorFiles,
  INDEX_FILES_BUDGET_MS,
} from '@sprigr/apps-file-indexing';

export async function runIndexFiles(env: DropboxEnv) {
  const store = createD1FileIndexingStore(env.DB); // the package's default tables
  const deadline = createDeadline(INDEX_FILES_BUDGET_MS); // once per tick
  for (const { scope } of await store.listEnabled()) {      // stale-first
    if (Date.now() >= deadline.at) break;                    // the rest sort first next tick
    if (!(await fileActorStillConnected(dropboxAdapter, scope, env))) continue;
    const outcome = await indexActorFiles(dropboxAdapter, store, env, scope, { deadline });
    // audit outcome.indexed / skipped / unresolved / error as the app does today
  }
  await drainPendingExtractions(store, env); // its own 15 s slice
}
```

## Worked example: a Dropbox adapter

Dropbox's listing is cursor-based like Graph delta: `files/list_folder` (recursive) enumerates everything and ends with a cursor; `files/list_folder/continue` returns changes since a cursor; a `409` with `reset` means the cursor is dead and the app must start over. Principals come from `sharing/list_file_members`, and every file in a shared folder has the same members, so they are cached per shared folder.

```ts
import {
  groupPrincipal,
  userPrincipal,
  type ChangePage,
  type FileSourceAdapter,
  type ResolvedPrincipals,
} from '@sprigr/apps-file-indexing';

type Entry = DropboxMetadata; // { '.tag': 'file' | 'folder' | 'deleted', id, name, path_display, ... }

// A deleted entry carries only a path (no id), so rows are keyed on the
// lowercased path: a deletion then names its own row, and a move arrives as a
// delete of the old path plus an entry at the new one.
const objectId = (key: string, pathLower: string) => `dbx:file:${key}:${pathLower}`;

function toPage(res: ListFolderResult, key: string): ChangePage<Entry> {
  const live = res.entries.filter((e) => e['.tag'] !== 'deleted');
  const removed = res.entries
    .filter((e) => e['.tag'] === 'deleted')
    .map((e) => ({ objectID: objectId(key, e.path_lower), path: e.path_display }));
  // has_more true: `cursor` continues THIS listing. false: it is the new baseline.
  return { entries: live, removed, cursor: res.cursor, hasMore: res.has_more };
}

export const dropboxAdapter: FileSourceAdapter<Entry, DropboxEnv> = {
  logLabel: '[dropbox-file-indexing]',
  eventPrefix: 'dropbox',
  eventIdField: 'fileId',
  objectIdsActorScoped: true,          // the actor key is in every objectID
  cursorResetDetail: 'list_folder_cursor_reset',
  objectIdPrefix: (ctx) => `dbx:file:${ctx.key}:`,

  async fullWalk(cursor, ctx) {
    const res = cursor
      ? await dbx(ctx, 'files/list_folder/continue', { cursor })
      : await dbx(ctx, 'files/list_folder', { path: '', recursive: true, limit: 500 });
    if (res.status === 409 && res.error?.['.tag'] === 'reset') return { entries: [], cursor: null, hasMore: false, reset: true };
    return toPage(res, ctx.key);
  },
  async listChanges(cursor, ctx) {
    return this.fullWalk(cursor, ctx); // same endpoint; the package knows which pass it is
  },

  async resolvePrincipals(entries, ctx) {
    const cache = new Map<string, string[] | 'unresolved'>();
    const out = new Map<string, ResolvedPrincipals>();
    for (const e of entries) {
      const folder = e.sharing_info?.parent_shared_folder_id ?? e.sharing_info?.shared_folder_id;
      if (!folder) {
        out.set(objectId(ctx.key, e.path_lower), []); // private: the package adds the owner
        continue;
      }
      if (!cache.has(folder)) {
        try {
          const m = await dbx(ctx, 'sharing/list_folder_members', { shared_folder_id: folder });
          cache.set(folder, [
            ...m.users.map((u) => userPrincipal(u.user.email)),
            ...m.groups.map((g) => groupPrincipal(g.group.group_id)),
          ]);
        } catch (err) {
          // 429 / 5xx: retry next pass (the cursor holds). A 403 would be 'denied'.
          cache.set(folder, isRetryable(err) ? 'unresolved' : []);
        }
      }
      out.set(objectId(ctx.key, e.path_lower), cache.get(folder)!);
    }
    return out; // shared LINKS stamp nothing: a link confers no search visibility
  },

  objectIdOf: (e, ctx) => objectId(ctx.key, e.path_lower),
  toObject: (e, acl_principals, ctx) => ({
    objectID: objectId(ctx.key, e.path_lower),
    acl_principals,
    name: e.name,
    path: e.path_display,
    isFolder: e['.tag'] === 'folder' ? 'true' : 'false',
    mimeType: e['.tag'] === 'folder' ? 'folder' : mimeFromName(e.name),
    size: e.size ?? 0,
    fileId: e.id,
    source: 'dropbox',
    modifiedAt: e.server_modified ?? '',
    createdAt: e.server_modified ?? '',
    content: '',
  }),

  downloadText: async (o, ctx) => (await dbxDownload(ctx, String(o.fileId))).text(),
  downloadBinary: (o, ctx) => dbxDownload(ctx, String(o.fileId)),
};
```

### Serialising passes: `runExclusive`

An adapter that must not run two passes over one scope at once (a webhook and the schedule racing on the same cursor) implements `runExclusive(scope, walkKey, fn, run)`. Return `{ busy: true }` (plus `purgePending: true` when a queued purge is the reason) to skip the pass, or `{ busy: false, value: await fn() }`. The fourth argument (0.1.1) is `{ env, deadline, now, purpose }`: the app env, so a lease kept in D1 reads `run.env.DB` without a per-env adapter; the tick deadline, to size the lease TTL; and `purpose`, `'index'` from `indexActorFiles` or `'acl_refresh'` from `refreshAclPrincipals`. An adapter written for 0.1.0 declares three parameters and keeps working.

```ts
async runExclusive(scope, walkKey, fn, { env, deadline }) {
  if (!(await acquireLease(env.DB, walkKey, deadline))) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
    await releaseLease(env.DB, walkKey);
  }
},
```

Team folders (Dropbox Business) slot in as `extraScopes`: one `ExtraScope` per team folder, each re-listed whole per pass, the same way microsoft-365 walks SharePoint libraries.

## The store

A new app uses the package's default tables: copy `DEFAULT_FILE_INDEXING_SCHEMA_SQL` into its first file-indexing migration (the app owns its migrations, which are immutable once published) and call `createD1FileIndexingStore(env.DB)` with no config. The two existing apps keep their tables:

```ts
import { createD1FileIndexingStore, GOOGLE_WORKSPACE_STORE_CONFIG, MICROSOFT_365_STORE_CONFIG } from '@sprigr/apps-file-indexing';

// google-workspace: gw_* tables, page_token, walk_list_token / walk_start_token
const gwStore = createD1FileIndexingStore(env.DB, { ...GOOGLE_WORKSPACE_STORE_CONFIG, redact: redactSecrets });

// microsoft-365: ms_* tables, delta_link, connection_id, acl_refresh_* columns
const msStore = createD1FileIndexingStore(env.DB, {
  ...MICROSOFT_365_STORE_CONFIG,
  walkKey: (s) => fileWalkKey(s.actor, s.connectionId!), // keep in-flight seen sets
  redact: redactSecrets,
});
```

| Config | Meaning |
|---|---|
| `tables` | the indexing, walk-seen and pending-extraction tables |
| `cursorColumn` | the provider cursor column (`page_token`, `delta_link`) |
| `connectionColumn` | per-connection scope (`connection_id`); scopes must then carry `connectionId` |
| `walkResumeColumns` | a full walk keeps its listing continuation and pre-walk baseline in their own columns (google-workspace 0012). Without them, the walk's continuation is the cursor itself (microsoft-365, dropbox) |
| `heldSinceColumn` | an INTEGER column that bounds the #2419 cursor hold. Neither app has it yet: add `ALTER TABLE <t> ADD COLUMN unresolved_held_since INTEGER` |
| `aclRefreshColumns` | where `refreshAclPrincipals` keeps its continuation and last completion |

## Disconnect purge: you provide the queue

`purgeActor(adapter, store, env, scope, { deadline })` switches indexing off first, drops the owner identity link, then deletes the scope's rows from the ACL index until the deadline leaves less than `MIN_PURGE_LEG_MS`. When it cannot finish (a large index, a truncated listing, a delete error) it returns `complete: false` with the rows it did remove in `removed`, and **that is all it does about the rest**. The store keeps no durable "purge pending" state, so nothing in this package will come back for the remainder. The app must: either record the unfinished prefixes in a queue of its own and drain them from a later tick with `purgeIndexPrefix` (microsoft-365 does this with its `ms_file_index_purge` table), or tell the user plainly that the disconnect did not finish and must be run again (google-workspace's behaviour today). Because indexing is switched off before any delete, an unfinished purge never re-indexes; it only leaves rows behind until the next attempt.

`purgeIndexPrefix(env, store, prefix, { deadline })` is one drain pass over one prefix, and it never throws. It returns `{ removed, complete, truncated, cut, unavailable?, error? }`: `truncated` means the listing stopped at the platform cap, `cut` means the deadline stopped the deletes, and `error` carries a listing, delete or cleanup failure, with `removed` still counting the chunks deleted before it. `complete` is true only when none of those happened. A queue drain keeps the row queued on `!complete` and records `error` as the row's last error when it is set:

```ts
const pass = await purgeIndexPrefix(env, store, row.prefix, { deadline });
if (pass.complete) await dequeue(row.prefix);
else await requeue(row.prefix, { removed: row.removed + pass.removed, lastError: pass.error ?? null });
```

It purges nothing, and says why in `purgeSkipped`, when the rows cannot be told apart by id: `'shared_prefix'` (install-scoped objectIDs such as `gw:file:<id>` with other actors indexing) or `'no_indexing_row'` (install-scoped objectIDs and this actor has no indexing row, so nothing under the shared prefix is provably theirs).

## Failure modes

- **`outcome.error = 'permissions_unresolved: ...'`, `held: true`**: some files' permissions could not be read; the cursor waits at that page and retries. After `MAX_UNRESOLVED_HOLD_MS` (6 h, needs `heldSinceColumn`) the pass skips them and reports `permissions_unresolved_released`.
- **`import_failed` / `delete_failed` / `reconcile_failed` / `walk_seen_record_failed`**: the cursor did not move; the next pass re-walks.
- **`<cursorResetDetail>`**: the provider rejected the cursor; it is reset and the next pass does a full walk.
- **`busy: true`**: `adapter.runExclusive` found another invocation holding the scope; nothing ran.
- **`purgeSkipped: 'shared_prefix'` / `'no_indexing_row'`**: see "Disconnect purge" above. Indexing is still switched off and the identity unlinked.
- **`purgeActor` returns `complete: false`**: the rest is yours to queue; see "Disconnect purge" above. A failed pass is in `errors` as `purge <prefix>: <message>`.
- **`purgeIndexPrefix` returns `error`**: the listing or a delete failed; `removed` counts what went before it. It no longer throws (0.1.0 did).
- **Reconcile skipped with "walk state moved"**: another invocation finished or restarted the walk; its reconcile covers it.

## Upgrading from 0.1.0

0.1.1 is additive except for one behaviour change, so bump the pin and check the purge drain:

1. **`purgeIndexPrefix` returns failures instead of throwing.** A drain that recorded a failure in its `catch` now gets `{ complete: false, error }` back and its `catch` never runs. Read `pass.error` where the `catch` used to set the row's last error or count a failure. Without that change the row still stays queued and is retried, but the failure is no longer recorded. `truncated` and `cut` now say why a pass was not complete.
2. **`@sprigr/apps-app-sdk` is a peer dependency** (`>=0.14.0 <1`). Nothing to change if the app already depends on the SDK; its bundle drops the second copy.
3. **`runExclusive` gets a fourth argument**, `{ env, deadline, now, purpose }`. Optional to use.
4. **`drainPendingExtractions` never starts a row with 0 ms or less left.** `minItemMs: 0` used to start one at exactly the deadline; it now behaves like `minItemMs: 1`, so an app that passed `1` to get that behaviour can keep it or drop it.

## API

Grammar: `PUBLIC_PRINCIPAL`, `ACL_PRINCIPALS_ATTR`, `userPrincipal`, `groupPrincipal`, `orgPrincipal`, `isValidPrincipal`, `normalizePrincipal`, `stampedPrincipalsValid`.

Content: `MAX_CONTENT_BYTES`, `MAX_CONTENT_CHARS`, `MAX_EXTRACT_INLINE_BYTES`, `MAX_EXTRACTIONS_PER_RUN`, `EXTRACT_STAGING_PREFIX`, `CONTENT_TRUNCATION_MARKER`, `extractFormatForMime`, `isTextLikeMimeType`, `capText`, `buildExtractJobToken`, `extractBinaryFileContent`, `enrichObjectsWithContent`.

Passes: `indexActorFiles`, `reconcileWalk`, `drainPendingExtractions`, `refreshPendingExtractions`, `forgetPendingExtractions`, `purgeActor`, `purgeIndexPrefix`, `refreshAclPrincipals`, `aclRefreshDue`, `countIndexedItems`, `importFileObjects`, `emitFileEvents`, `actorOfFileRow`, `fileActorStillConnected`.

Budgets: `TickBudget`, `mapWithConcurrency`, `createDeadline`, `deadlinePassed`, `budgetBelow`, `remainingBudgetMs`, `INDEX_FILES_BUDGET_MS`, `EXTRACTION_DRAIN_BUDGET_MS`, `EMIT_BUDGET_MS`, `MIN_ITEM_BUDGET_MS`. The `Deadline` type is `@sprigr/apps-fetch-budget`'s, so one deadline bounds both the loop and each fetch.

Store: `createD1FileIndexingStore`, `DEFAULT_FILE_INDEXING_STORE_CONFIG`, `DEFAULT_FILE_INDEXING_SCHEMA_SQL`, `GOOGLE_WORKSPACE_STORE_CONFIG`, `MICROSOFT_365_STORE_CONFIG`, `defaultRedact`.

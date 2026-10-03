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
| Content | Text-like files up to 256 KB, native exports, and PDF/OOXML through the platform extract bridge (5 per pass, staged under random single-use keys); pptx drains as a durable job. Binaries of 16 MiB or more stay metadata-only. Text is capped at 32000 chars, and a cut is logged and marked |
| Content backlog | A file the pass could not fetch text for (the deadline passed, the 5-binary cap was spent, its drive answered 429, or the fetch threw) is queued for a content fill and filled by later passes of the same scope; `outcome.contentPending` counts what still waits (sprigr-apps#2702) |
| Reconcile | A completed full walk deletes index rows the walk did not see (diff of `data.listIds`, never on uncertainty). A completed walk that saw NOTHING (the user emptied the drive) deletes every row under the prefix; on a truncated listing it deletes the listed subset and the next completed walk continues. An errored, cut or held walk, or one that established no cursor, deletes nothing (sprigr-apps#2690) |
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
    // audit outcome.indexed / skipped / unresolved / error as the app does today;
    // outcome.contentPending says how many files still wait for their text
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

## Content fills: the backlog a pass leaves

A pass fetches text one file at a time and stops STARTING fetches at its deadline, after `MAX_EXTRACTIONS_PER_RUN` binaries, and for a drive that answered 429. The rows are still imported and the cursor still moves (the cursor discipline above is unchanged); each file left without the text it could have had is recorded in the store's pending-extraction table under the token `content-fill:<walkKey>`, so no migration is needed. A fetch that throws is recorded too. 0.1.1 imported those files metadata-only and forgot them, so a 300-file burst into Dropbox left 215 files searchable by name only, with the status still `ok` (sprigr-apps#2702).

Every later `indexActorFiles` pass of the same scope ends with a drain: after the cursor moves, it reads up to `MAX_CONTENT_FILLS_PER_PASS` (100) of the scope's rows, least recently touched first, and fills them one by one while at least `MIN_ITEM_BUDGET_MS` is left of BOTH the pass deadline and its own `CONTENT_FILL_BUDGET_MS` (15 s) slice. It shares the pass's extraction cap and 429 set, and it never runs a pass past its deadline: a webhook pass whose walk used its budget fills nothing, and the schedule's passes catch up. `contentFillBudgetMs: 0` turns the drain off for one pass (the rows wait); `maxContentFills` caps the rows read.

Per row the drain:

- re-reads the file when the adapter implements **`refetchEntry(object, ctx)`** (return the provider's current entry, or `null` when it is gone). A vanished file's row is dropped; the row is re-stamped from the current entry through the same fail-closed stamping as the walk, so its text is written under the principals the file has NOW, with its new revision, name and path. Unreadable permissions leave the row queued. Without `refetchEntry` it uses the stored record, which every walk that imports the file refreshes and every permission re-stamp updates;
- fetches the text the way the walk does (`downloadText`, `exportNative`, or the extract bridge; a pptx turns into a durable extraction job);
- imports the row through the validated `withAcl` import and deletes the queue row. A `withAcl` partial update cannot carry `content` (the platform only allows `acl_principals` there), so the row is imported whole.

A row is dropped (and logged) when the file vanished (`refetchEntry` returned null, or `downloadText` returned `{ missing: true }`), no longer qualifies for text, lost every principal, or its fetch failed `MAX_CONTENT_FILL_ATTEMPTS` (5) times. A walk that imports the file WITH its text drops the row; a deleted file, the reconcile and `purgeActor` drop it as well. A file that already has a platform extraction job or an app's own queue row is never overwritten by a fill.

Show the backlog. `outcome.contentPending` (and `countPendingContentFills(store, scope)` for a status tool) is the number of files of that scope still searchable by name only; `describeContentPending(n)` gives the sentence for the agent reading the status ("12 files are searchable by name only until their text is processed; a search by what a file says can miss it until then, so read the file itself before saying its text does not exist."). An app that reports "ok" while this is above zero tells agents the text does not exist.

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
- **`content_fill_record_failed: ...`**: the files this pass could not fetch text for could not be queued (a store write failed). The pass keeps its cursor and imports nothing, so the next pass re-walks them rather than importing them without text and forgetting them.
- **`outcome.contentPending > 0`**: files imported without their text that later passes are filling; see "Content fills" above. Not an error.

## Upgrading from 0.1.0

0.1.1 is additive except for two behaviour changes (items 1 and 4), so bump the pin and check the purge drain:

1. **`purgeIndexPrefix` returns failures instead of throwing.** A drain that recorded a failure in its `catch` now gets `{ complete: false, error }` back and its `catch` never runs. Read `pass.error` where the `catch` used to set the row's last error or count a failure. Without that change the row still stays queued and is retried, but the failure is no longer recorded. `truncated` and `cut` now say why a pass was not complete.
2. **`@sprigr/apps-app-sdk` is a peer dependency** (`>=0.14.0 <1`). Nothing to change if the app already depends on the SDK; its bundle drops the second copy.
3. **`runExclusive` gets a fourth argument**, `{ env, deadline, now, purpose }`. Optional to use.
4. **A completed full walk of an empty source now reconciles** (sprigr-apps#2690). 0.1.0 skipped the reconcile whenever the walk saw zero entries, so an emptied drive kept every row, full text searchable. Now every row under the prefix goes, but only when the walk reached its final page with no error, cut or hold and established a cursor. A truncated listing deletes the listed subset, and the next completed walk deletes more. An adapter with `reconcilePrefixes` is called with an empty seen list and decides which prefixes that covers (microsoft-365's returns none, so its SharePoint rows stay out of it). A direct `reconcileWalk` call must pass `{ completedWalk: true }` to get this.
5. **`drainPendingExtractions` never starts a row with 0 ms or less left.** `minItemMs: 0` used to start one at exactly the deadline; it now behaves like `minItemMs: 1`, so an app that passed `1` to get that behaviour can keep it or drop it.

## Upgrading from 0.1.1

0.1.2 (sprigr-apps#2702) needs no migration: content fills live in the pending-extraction table every app already has. Bump the pin, then:

1. **Show `contentPending`.** `indexActorFiles` now returns `contentDeferred`, `contentFilled` and `contentPending`. Wire `contentPending` (or `countPendingContentFills(store, scope)`) into the status the app shows, with `describeContentPending`, instead of reporting a bare "ok" while files wait for their text.
2. **A store with its own `listPendingExtractions` SQL must leave content-fill rows out** (`substr(job_token, 1, length('content-fill:')) != 'content-fill:'`, or `!isContentFillToken(row.job_token)`). `drainPendingExtractions` skips any it is handed, but a listing that returns them can fill its page with them and starve the real extraction jobs. dropbox's `withoutRivieraRows` is one.
3. **Optional: implement `refetchEntry`** so a fill re-reads the file's current permissions and revision and drops a vanished file at once.
4. **Optional: return `{ text: '', missing: true }` from `downloadText`** when the provider says the file is gone, so its fill is dropped instead of retried.
5. **Behaviour changes.** `EnrichSummary.deferredDeadline` and `skippedThrottled` now count only files that could have had text (0.1.1 counted folders and metadata-only files too), and `enrichObjectsWithContent` records its deferrals unless called with `recordDeferred: false`. `listPendingExtractionsFor` also returns `job_token`. `store.enable` clears the scope's old fills, and the permission re-stamp writes the new principals into waiting rows' stored records too. A binary of 16 MiB or more was never extracted (the old comment said it drained as a job; it did not) and still stays metadata-only.
6. **`EXTRACTION_DRAIN_BUDGET_MS` is unchanged**, and a pass never runs past its deadline: the fill drain only uses time the pass has left.

## API

Grammar: `PUBLIC_PRINCIPAL`, `ACL_PRINCIPALS_ATTR`, `userPrincipal`, `groupPrincipal`, `orgPrincipal`, `isValidPrincipal`, `normalizePrincipal`, `stampedPrincipalsValid`.

Content: `MAX_CONTENT_BYTES`, `MAX_CONTENT_CHARS`, `MAX_EXTRACT_INLINE_BYTES`, `MAX_EXTRACTIONS_PER_RUN`, `EXTRACT_STAGING_PREFIX`, `CONTENT_TRUNCATION_MARKER`, `extractFormatForMime`, `isTextLikeMimeType`, `capText`, `buildExtractJobToken`, `extractBinaryFileContent`, `enrichObjectsWithContent`, `contentKindFor`, `fetchObjectContent`.

Content fills: `CONTENT_FILL_TOKEN_PREFIX`, `CONTENT_FILL_BUDGET_MS`, `MAX_CONTENT_FILLS_PER_PASS`, `MAX_CONTENT_FILL_ATTEMPTS`, `contentFillToken`, `isContentFillToken`, `storeSupportsContentFills`, `recordContentFills`, `drainContentFills`, `countPendingContentFills`, `describeContentPending`, `syncPendingRecordPrincipals`.

Passes: `indexActorFiles`, `reconcileWalk`, `drainPendingExtractions`, `refreshPendingExtractions`, `forgetPendingExtractions`, `purgeActor`, `purgeIndexPrefix`, `refreshAclPrincipals`, `aclRefreshDue`, `countIndexedItems`, `importFileObjects`, `emitFileEvents`, `actorOfFileRow`, `fileActorStillConnected`.

Budgets: `TickBudget`, `mapWithConcurrency`, `createDeadline`, `deadlinePassed`, `budgetBelow`, `remainingBudgetMs`, `INDEX_FILES_BUDGET_MS`, `EXTRACTION_DRAIN_BUDGET_MS`, `EMIT_BUDGET_MS`, `MIN_ITEM_BUDGET_MS`. The `Deadline` type is `@sprigr/apps-fetch-budget`'s, so one deadline bounds both the loop and each fetch.

Store: `createD1FileIndexingStore`, `DEFAULT_FILE_INDEXING_STORE_CONFIG`, `DEFAULT_FILE_INDEXING_SCHEMA_SQL`, `GOOGLE_WORKSPACE_STORE_CONFIG`, `MICROSOFT_365_STORE_CONFIG`, `defaultRedact`.

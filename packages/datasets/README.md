# @sprigr/apps-datasets

Write an install's datasets through `env.SPRIGR.datasets.append` (decisions 0079 and 0115). A dataset is bulk, analytical or confidential rows the platform stores as Parquet on R2 under the install's prefix, validated against the manifest's `datasets` contract and read by the conform build through `app_dataset`. Agents never read it.

The platform takes at most 1,000 rows per append and throws when it refuses one. This package is the code every dataset-writing app had been copying around that call.

```ts
import { appendInBatches, datasetRows, type SprigrDatasetsApi } from '@sprigr/apps-datasets';

// Index docs carry a deterministic objectID; a dataset row may not.
const rows = datasetRows(docs, Date.now()); // objectID -> row_key, imported_at = epoch ms
const stored = await appendInBatches(env.SPRIGR.datasets, 'daily_metrics', rows, {
  concurrency: 4,          // appends in flight; default 1
  logPrefix: '[my-import]', // retry warnings
});
```

The manifest entry those rows go to is a keyed dataset whose key is `row_key` and whose version is `imported_at`, so a re-import of a day replaces the earlier row for the same key:

```json
"datasets": {
  "daily_metrics": {
    "mode": "keyed",
    "key": ["row_key"],
    "version_field": "imported_at",
    "partition_key": ["date"],
    "contract_version": 1,
    "fields": {
      "row_key": { "type": "string" },
      "date": { "type": "date" },
      "clicks": { "type": "number" },
      "imported_at": { "type": "number" }
    }
  }
}
```

## Exports

| Export | What it does |
|---|---|
| `SprigrDatasetsApi`, `DatasetAppendResult`, `DatasetRow` | Types for `env.SPRIGR.datasets`. Bind it as optional on your env: it is absent under `next dev` and on a platform that predates datasets. |
| `datasetRows(docs, importedAtMs)` | Index docs to keyed rows: `objectID` becomes `row_key`, `imported_at` is set to epoch ms. `importedAtMs` is one number for the page or a function of the doc. |
| `appendWithRetry(datasets, name, rows, opts?)` | One append of at most 1,000 rows. Retries a 5xx after each of `delays` (default `APPEND_RETRY_DELAYS_MS`, 500 ms then 2 s), never a 4xx. Throws `DatasetAppendError` on an `ok: false` answer unless `requireOk: false`. Returns the platform's answer. |
| `appendInBatches(datasets, name, rows, opts?)` | Any number of rows as appends of `batchSize` (at most and by default 1,000), `concurrency` at a time, each through `appendWithRetry`. Returns the rows stored. |
| `isRetryableAppendError(err)` | True for an append failure the platform reported as a 5xx (R2's transient `500 put ... (10001)`). |
| `MAX_APPEND_ROWS`, `APPEND_RETRY_DELAYS_MS` | 1,000 and `[500, 2000]`. |

Options shared by both append calls: `sleep` (a recorder in tests), `delays`, `logPrefix`, `requireOk`.

A retry is safe because rows are keyed by `row_key`: a batch that landed before the error is replaced, not duplicated, in the current view.

## Tombstones for keys a re-walk drops (0.2.0)

A keyed dataset upserts by key. When a source restates a day (an analytics property finalising it, a report service recomputing it) and a row moves to another key or disappears, the re-import writes the new rows but the old key stays in the current view, and a sum over the view counts it twice. Append `_deleted: true` for each key the last completed walk of that date wrote and this one did not return.

| Export | What it does |
|---|---|
| `recordWalkPage(store, scope, position, { next, truncated, keys })` | Saves one page's keys. Call it after the page's rows are stored and before the cursor moves past the page; fail the page if it throws. `position` is the source's own cursor (a page token, `request-offset`); the first page is `FIRST_PAGE`; `next` is the next page's position, or `null` on the page that completes the day. |
| `completeWalk(store, scope)` | Reads the walk back from `FIRST_PAGE` and answers `tombstone` (`rowKeys` to delete), `first` (no baseline yet) or `skipped` (`broken_chain`, `truncated`, `mass_drop`: deletes nothing). Only reads. |
| `finishWalk(store, scope, completion, windowStart)` | After the tombstones are stored: keeps the walk as the new baseline when the date is on or after `windowStart`, deletes the walk's page files, and prunes the scope's sets dated before `windowStart`. A skipped walk keeps the old baseline. |
| `WalkKeyStore`, `WalkScope`, `WalkPage`, `WalkCompletion`, `FIRST_PAGE`, `MAX_TOMBSTONE_FRACTION` | The store an app wires to its own file storage (`get`, `put`, `delete`, `list`), one walk's `{ dir, date, keyPrefix }`, and the guard (0.5). |

```ts
const scope = { dir: `walk-keys/${account}/${family}`, date, keyPrefix: `perf-${account}-${date}-` };
await recordWalkPage(store, scope, position, { next: nextPosition, truncated, keys: docs.map((d) => d.objectID) });
if (nextPosition === null) {
  const c = await completeWalk(store, scope);
  if (c.kind === 'tombstone' && c.rowKeys.length > 0) {
    // requireOk stays true: a refusal must throw here, before finishWalk.
    await appendInBatches(datasets, dataset, c.rowKeys.map((row_key) => ({ row_key, _deleted: true, imported_at: Date.now() })));
  }
  await finishWalk(store, scope, c, trailingWindowStart);
}
```

Only track dates the walk can still revisit, and append the tombstones before `finishWalk` with a call that throws on a refusal, or a refused append would let the baseline move forward and the dropped keys would never be deleted.

## Testing: check rows against the real manifest

`@sprigr/apps-datasets/testing` mirrors the append route's row check (sprigr-team `validateDatasetRows`), so a field the manifest does not declare fails in your tests, not on prod:

```ts
import { fakeDatasets, checkAppend } from '@sprigr/apps-datasets/testing';
import manifest from '../sprigr-app.json';

const datasets = fakeDatasets(manifest); // validates every append, records accepted ones
await runImport({ ...env, SPRIGR: { data, datasets } });
expect(datasets.appended.map((a) => a.dataset)).toEqual(['daily_metrics']);

// Or inside your own fake:
append: async (name, rows) => { checkAppend(manifest, name, rows); return { ok: true, rows: rows.length }; }
```

`checkAppend` throws naming the first problem (`dataset_undeclared: x`, `bad row count 0`, `unknown_field daily_metrics.objectID (row 0)`, `type_mismatch ...`, `missing_key ...`, `missing_partition ...`, `bad_date ...`, `reserved_field ...`). `validateDatasetRows(decl, rows)` returns every error (up to 50) instead.

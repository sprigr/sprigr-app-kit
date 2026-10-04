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

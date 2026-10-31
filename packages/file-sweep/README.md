# @sprigr/apps-file-sweep

A bounded, resumable sweep of a marketplace app's own `env.SPRIGR.files` store, deleting entries past their life.

The platform never prunes an app's store while the install lives. An app that keeps copies nothing reads after their link expires (offloaded read results, attachment copies, staged uploads) needs its own sweep. This package is the walk those sweeps share. The app supplies:

- **which keys are its to judge** (`classify`, null = leave it alone),
- **when one has expired** (`isExpired`),
- **where the walk's state lives** between ticks (`state.read` / `state.write`, e.g. a settings row in the install's D1).

```bash
npm install @sprigr/apps-file-sweep   # exact-pin it, like every @sprigr/apps-* package
```

```ts
import { runFileSweep, totalOf } from '@sprigr/apps-file-sweep';

const OFFLOAD_KEY = /^read_file\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/[0-9a-f]{40}\/[^/]+$/;

const until = Date.now() + 20_000;                   // this tick's budget
const result = await runFileSweep({
  files: env.SPRIGR.files,
  prefixes: ['read_file/'],
  classify: (key) => (OFFLOAD_KEY.test(key) ? 'read_file' : null),
  isExpired: (uploadedMs, startedAt) => uploadedMs + 7 * 86_400_000 < startedAt,
  mode: 'delete',
  walkId: new Date().toISOString().slice(0, 10),      // one walk per UTC day
  state: { read: () => getSetting(db, KEY), write: (raw) => setSetting(db, KEY, raw) },
  hasBudget: () => Date.now() < until,
});
if (result.finished_now && result.state) {
  const deleted = totalOf(result.state.deleted);
  // log one summary per walk
}
```

## What it never does

- **Delete a key `classify` did not name.** Directory markers and keys in a shape the app never writes are counted in `skipped` and left alone. Write `classify` to match only the exact key shape your app writes.
- **Expire an entry with no parseable `uploaded` time.**
- **Delete anything in `report` mode.** Report mode counts `seen`, `expired` and `skipped` per kind and keeps up to `sampleSize` expired keys in `samples`, so a first run can be reviewed before deletes start.
- **Throw.** A failed listing or delete ends the tick; the walk resumes from the same page next tick.

## The walk

One `files.list(prefix, { cursor })` page at a time, following the platform's cursor. A page's counts are merged only once the whole page is judged, so a page cut short by the delete cap or the budget is listed again next tick and never counted twice. An unfinished walk always resumes; a finished one starts again only under a new `walkId`. A mode change starts a fresh walk.

Per tick: at most `maxListingsPerTick` listings (default 16) and `maxDeletesPerTick` deletes (default 200), each started only while `hasBudget()` is true and each bounded by `callTimeoutMs` (default 10s).

`deleteOptions(entry)` adds fields to each `files.delete` call (an `owner_ref` for an actor-scoped store), and `accept(entry)` filters entries after `classify`.

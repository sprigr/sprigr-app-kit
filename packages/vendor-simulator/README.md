# @sprigr/apps-vendor-simulator

Sample mode for marketplace apps. While an install is in sample mode, the app's vendor requests are answered from a seed shipped in the app bundle plus a per-install overlay of writes in the app's own D1. Nothing reaches the vendor.

```bash
npm install @sprigr/apps-vendor-simulator   # exact-pin it, like every @sprigr/apps-* package
```

Why it works this way: [decision 0002](../../docs/decisions/0002-sample-mode-is-a-per-install-flag-and-a-simulator-behind-fetchimpl.md).

## 1. The table (your migration)

The app owns the table, like `@sprigr/apps-d1-kv`. Any plain identifier works as the name:

```sql
CREATE TABLE sample_objects (
  resource TEXT NOT NULL,
  id       TEXT NOT NULL,
  body     TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource, id)
);
```

One reserved row, `(__sample_mode__, flag)`, is the sample flag. Row present means on; no row means off.

## 2. The hooks

Declare two `tools[]` entries named exactly `on_sample_load` and `on_sample_remove`, `"internal": true`, like the lifecycle hooks in the app development guide.

```ts
// src/handlers/sample-hooks.ts
import { createSampleStore, sampleLoadHook, sampleRemoveHook } from '@sprigr/apps-vendor-simulator';

const storeFor = (env: Env) => createSampleStore({ db: env.DB, table: 'sample_objects' });

export default {
  on_sample_load: sampleLoadHook(storeFor),     // sets the flag
  on_sample_remove: sampleRemoveHook(storeFor), // deletes the flag and every write
};
```

A failed write or delete throws, so the platform sees the hook fail. For `on_sample_remove` that keeps sample mode on for the workspace instead of leaving an install half cleared.

## 3. Every vendor call

Build the switch once per invocation, never at module level: it reads the flag at most once and keeps the answer, so a switch that outlives the request misses a flip.

```ts
import { createSampleStore, createSampleSwitch, createSimulator, plainDialect, sampleAwareFetch } from '@sprigr/apps-vendor-simulator';
import { fetchWithBudget } from '@sprigr/apps-fetch-budget';
import seed from './sample-seed.json';

const dialect = plainDialect({
  base: '/api',
  routes: [
    { method: 'GET', path: '/items', op: 'list', resource: 'items', wrap: 'Items', filters: { status: 'Status' } },
    { method: 'GET', path: '/items/:id', op: 'get', resource: 'items', wrap: 'Items' },
    { method: 'POST', path: '/items', op: 'create', resource: 'items', wrap: 'Items', bodyKey: 'Items' },
  ],
});

export function vendorFetch(env: Env) {
  const store = createSampleStore({ db: env.DB, table: 'sample_objects' });
  return sampleAwareFetch({
    sampleSwitch: createSampleSwitch(store),
    simulator: createSimulator({ seed, dialect, store }),
    network: (input, init) => fetch(input, init),
  });
}

// per invocation:
const fetchImpl = vendorFetch(env);
const resp = await fetchWithBudget(url, init, deadline, { fetchImpl });
```

| Flag | What answers |
|---|---|
| on | the simulator; the network is never called |
| off | the network, with the same request |
| unknown (the read failed) | nothing: `SampleModeUnknownError`, code `sample_mode_unknown` |

A request the engine does not model throws `NotSimulatedError` (code `not_simulated`, with `method`, `path` and `reason`). It is never sent to the vendor. See [What is refused](#what-is-refused).

**Both errors mean nothing was sent.** `SampleModeUnknownError` and `NotSimulatedError` are thrown out of the `fetchImpl` before any request leaves the app. Map them, by `instanceof` or `.code`, to your not-sent answer. Never treat them as an unknown outcome: a write path that reads any throw from fetch as "outcome unknown" would answer `write_may_have_applied` for a request that was never sent. Your adoption tests should include a write with the flag unreadable that answers not sent.

## The plain dialect

Routes map a method and a path under `base` to one of `list`, `get`, `create`, `update`, `delete`, `action` on a seed resource.

- `wrap`: the response envelope key. Without it, a list is a bare array and a get is the bare object.
- `bodyKey`: where a write's objects sit in the request body. Without it, the body is the object (or an array of them).
- `filters` (list only): query parameter to field, equality on the field's string form.
- `query` (list only): query parameter to a function your app supplies, `(value, items) => items | null`, for a vendor syntax the engine does not parse. It runs after `filters`. Return `null` when you cannot apply the value; the request is refused.
- `sort.param` (list only): `Field`, `Field ASC` or `Field DESC`; numbers compare as numbers.
- `page` (list only): `{ param, size, first, always }`. A list is paged when the parameter is sent. With `always: true` it is also paged when the parameter is absent, answering page `first`. `plainDialect` throws a `TypeError` at build unless `size` is a whole number above 0 and `first`, when given, is a whole number of 0 or more.
- `envelope` (list only): fields beside `wrap`, computed from the page. See [Envelope fields](#envelope-fields).
- `parent`: `{ param, resource, field }` for a route under a parent object, such as `/projects/:projectId/tasks`. `param` is the parent's path parameter, `resource` its seed resource, and `field` the child's field holding the parent id.
- `upsert` (create only): for a vendor whose create endpoint also updates. An object whose id already exists is merged and completed as an update instead of refused.
- `replace` (update, or upsert create, only): for a vendor whose update replaces the whole object. The stored object is the body plus its id and parent field, not the body merged onto the old object. A body that leaves out a field every seed object carries is refused `computed` unless `complete` fills it, so a replace works for full bodies. Any other route with `replace` fails the build.
- `action` and `answer` (action only): see [Action routes](#action-routes).

A get, update, delete or action route names its object id `:id`. Any other path parameter must be its declared parent's; `plainDialect` throws a `TypeError` at build otherwise.

**Which route answers.**
- A request's path is matched before its method. Of the routes, of any method, and the `reserved` paths that fit the path, the most specific wins: at the first segment where two differ, a literal beats a parameter.
- The route with that pattern and the request's method answers. If there is none, the request is refused (`no_route`).
- Declaration order does not matter, and segments are decoded before they are compared.

**`reserved`** (a `plainDialect` option) lists vendor paths that no route models, such as `['/contacts/settings']`. A reserved path answers nothing; it only stops a parameter route from taking it. So `GET /contacts/settings` is refused, not answered 404 as the contact with id `settings`.

**Build throws (`TypeError`):**
- a reserved path with the same pattern as a route;
- two routes with the same method and pattern;
- a reserved path that does not start with `/` or repeats a parameter name.

The dialect matches the method and the path only, never the host. If your app calls two hosts, a path that matches a route is simulated whichever host it was sent to, and a call to a host whose paths have no route is refused with `NotSimulatedError`.

A create without an id, or with a `null` one, gets a UUID, or the id its resource's `newId` returns; a body id must otherwise be a non-empty string or a finite number. A create carrying an id that already exists is refused unless the route declares `upsert`. An update merges fields into the object, or replaces it on a route that declares `replace`. A delete hides the object from list and get. Writes go to the overlay only; the seed is never changed.

Under a parent, a list returns only that parent's children. A get, update or delete of another parent's child answers 404, as does any request under a parent that does not exist. A create stores the parent id from the path.

**Seed ids.** `createSimulator` throws a `TypeError` naming the resource, before any request, when a seed object has no id, a `null` one, or one that is not a usable id (a non-empty string or a finite number). It also throws when two objects of one resource have ids equal as strings, `5` and `"5"` included: the store keys objects by that string, so the later one would hide the earlier. A seed object's parent field is not checked.

### What the vendor computes

A vendor fills fields in on a write: a number, totals, an amount due. The engine never answers with an object missing them.

**The seed check.** Every object the engine answers with, on a read or a write, must carry each field that every seed object of its resource carries, plus the resource's declared `computed` fields. A field counts when its key is present, whatever the value, `null` included. An object missing one is refused (`computed`). A write is refused before its first write. A list with one failing object is refused whole. The field set is taken from the seed once, at build, never from the overlay.

So a route with no completion answers a create only when the body already carries every such field. Otherwise it refuses.

**Completion.** `plainDialect`'s `resources` option, keyed by seed resource, says how your app fills those fields:

```ts
resources: {
  invoices: {
    computed: ['AmountDue'],              // fields not every seed object shows
    complete: (obj, { op, previous, objects, parentId }) => ({ ...obj, Total: total(obj.Lines) }),
    uses: ['payments'],                   // what derive reads
    derive: (obj, { payments }) => ({ ...obj, AmountDue: Number(obj.Total) - paid(payments, obj.InvoiceID) }),
  },
},
```

- `complete` runs on every create and update, before the write, and returns the object to store. `objects` is the resource's view including the objects already written earlier in the same request, so a next number counts them. It cannot change the id, or on a route with a `parent` the parent field: the engine puts both back, so a write never moves an object.
- `derive` runs on every answered object and is never stored. Use it for a field that depends on another resource. A payment then changes its invoice's amount due on the next read, without writing the invoice. Its result keeps the stored object's id and parent field.
- `newId` forms the id of a create that carries none, for a vendor whose ids are codes or numbers rather than UUIDs: `newId: ({ objects, parentId }) => nextCode(objects)`. It runs before `complete` and sees the same `objects`. It returns a string or a number; a number is stored and answered as a number and keyed by its string form, so a get of `/1042` finds `1042`. An id already in that view is refused as `exists`, and a value that is neither a non-empty string nor a finite number as `computed`, both before any write.
- A throw from any of them is refused as `computed`, with the throw as the error's `cause`.

**Build throws (`TypeError`):**
- `computed` with neither `complete` nor `derive`;
- `uses` without `derive`;
- a `resources` key or a `uses` entry that is not a seed resource;
- a resource with a create or update route whose seed has no objects and that declares no `computed` (declare `computed: []` if the vendor computes nothing);
- a declared `computed` field that some seed object lacks when the resource has no `derive` to fill it on a read.

### Action routes

For a call that takes no body and acts on one object, such as approve or send:

```ts
{ method: 'POST', path: '/claims/:id/approve', op: 'action', resource: 'claims', action: 'approve', answer: 'object' }
```

- **What it changes:**
  - The resource's `complete` is called with the stored object, `op: 'action'`, `action` set to the route's name, and `previous`. Use `action` to tell the call apart from an edit.
  - The result is derived and seed-checked, and its id and parent field are put back.
  - It is written only when it differs from the stored object, so an action that changes nothing costs no write.
- **What it answers:**
  - `answer: 'object'` answers 200 with the object, wrapped as a get.
  - `answer: 'empty'` answers 204 with an empty body.
- **What it refuses:**
  - any request body, `{}` included (`body`). A `Content-Type` header with an empty body is answered.
  - any query parameter (`query`).
- **What answers 404:** an unknown id, another parent's child, or a missing parent, as on a get, update or delete.
- **Build throws (`TypeError`):**
  - no `:id`;
  - a missing or empty `action`, or `action` on another op;
  - a missing `answer`, or `answer` on another op;
  - a resource whose `resources` entry has no `complete`.

### Envelope fields

For a vendor that answers a list with fields beside it, such as a page count:

```ts
{ method: 'GET', path: '/projects', op: 'list', resource: 'projects', wrap: 'items',
  page: { param: 'page', size: 50, first: 1, always: true },
  envelope: { 'pagination.page': 'page', 'pagination.pageCount': 'pageCount', 'pagination.itemCount': 'total' } }
```

Each key is a dotted path beside `wrap`. Each value is one the engine computes:

| Value | What it is |
|---|---|
| `total` | items matched after `filters` and `query` functions, before paging |
| `count` | items on this page |
| `page` | the page number answered |
| `pageSize` | `page.size` |
| `pageCount` | `total` divided by `page.size`, rounded up; 0 when nothing matched |

Every field can be computed for every answer, so nothing is refused at request time. **Build throws (`TypeError`):**
- `envelope` on a route other than a list, or without `wrap`;
- a path that starts at the `wrap` key, is a prefix of another path, or has an empty segment;
- a value not in the table;
- `page`, `pageSize` or `pageCount` on a route without `page.always`, since an unpaged answer has no page to describe.

Whether Xero's Projects API pages when no page is asked for is not verified, so whether a Xero dialect sets `always` is decided where Xero adopts this package.

### What is refused

The engine refuses what it does not model, so it never answers wrongly. Each refusal is a `NotSimulatedError` thrown before anything is written, and its `reason` says why:

| `reason` | When |
|---|---|
| `no_route` | No route matches the path, the most specific pattern for the path has no route for the method, or that pattern is a `reserved` path. |
| `query` | A query parameter the route does not declare (a get, update or delete declares none), one sent twice, a sort value other than `Field`, `Field ASC` or `Field DESC`, a page value that is not a whole number at or above `first`, or a `query` function that returned `null`. |
| `accept` | The most preferred `Accept` range does not admit JSON: highest `q` wins, the first on a tie. No `Accept`, `application/json`, `application/*+json`, `application/*` and `*/*` all admit it. |
| `content_type` | A create or update whose body is declared or built as something other than JSON, such as a multipart upload. A string body passed in `init` with no `Content-Type` header is read as JSON. A `Request` built with a string body and no header carries the `text/plain` type the platform sets, so it is refused; give it `Content-Type: application/json`. |
| `parent` | A create or update whose body sets the parent field to a different parent or to a value that is not a usable id (`["p1"]` does not name `p1`), or a create whose id is already another parent's child. |
| `computed` | An answered object misses a field every seed object carries or a declared `computed` field; `complete`, `derive` or `newId` threw; or `newId` returned no usable id. See [What the vendor computes](#what-the-vendor-computes). |
| `exists` | A create carrying an id that already exists, on a route without `upsert`, or an id from `newId` that already exists. Checked for the whole batch. |
| `body` | A body the route cannot take: any request body sent to an action route, `{}` and JSON included (an action takes none), an update whose body carries more than one object, or a create whose body carries none (`[]`, bare or under `bodyKey`). Nothing is written. |
| `id` | A create whose body id is present, not `null`, and not a usable id: a usable id is a non-empty string or a finite number, so `true`, `{}`, `[]`, `""` and `1e400` are refused. Checked for the whole batch, before any write. Also an update whose body id is present, not `null`, and is not a usable id or is not the object's own id (compared as strings, so `1041` matches the path's `"1041"`). Nothing is written. |

## Cost

One D1 read per invocation that makes a vendor call (the flag), whether or not the install is in sample mode. In sample mode, there are further D1 operations:
- one more read per simulated request (the overlay for that resource);
- one more on a route with a `parent` (the parent's overlay);
- one more per `uses` resource on any request to that resource except a delete;
- one write per created, updated or deleted object, and per object an action changed.

A request refused for its query, `Accept`, `Content-Type` or an action's body costs no overlay read.

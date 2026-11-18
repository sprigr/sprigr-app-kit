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

A request the dialect has no route for throws `NotSimulatedError` (code `not_simulated`, with `method` and `path`). It is never sent to the vendor.

**Both errors mean nothing was sent.** `SampleModeUnknownError` and `NotSimulatedError` are thrown out of the `fetchImpl` before any request leaves the app. Map them, by `instanceof` or `.code`, to your not-sent answer. Never treat them as an unknown outcome: a write path that reads any throw from fetch as "outcome unknown" would answer `write_may_have_applied` for a request that was never sent. Your adoption tests should include a write with the flag unreadable that answers not sent.

## The plain dialect

Routes map a method and a path under `base` to one of `list`, `get`, `create`, `update`, `delete` on a seed resource.

- `wrap`: the response envelope key. Without it, a list is a bare array and a get is the bare object.
- `bodyKey`: where a write's objects sit in the request body. Without it, the body is the object (or an array of them).
- `filters`: query parameter to field, equality on the field's string form.
- `sort.param`: `Field` or `Field DESC`; numbers compare as numbers.
- `page`: `{ param, size, first }`; a list is paged only when the parameter is sent.

The dialect matches the method and the path only, never the host. If your app calls two hosts, a path that matches a route is simulated whichever host it was sent to, and a call to a host whose paths have no route is refused with `NotSimulatedError`.

A create without an id gets a generated one. An update merges fields into the object. A delete hides the object from list and get. Writes go to the overlay only; the seed is never changed.

## Cost

One D1 read per invocation that makes a vendor call (the flag), whether or not the install is in sample mode. In sample mode, one more read per simulated request (the overlay for that resource) and one write per created, updated or deleted object.

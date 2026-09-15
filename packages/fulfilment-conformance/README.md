# @sprigr/apps-fulfilment-conformance

The executable half of [`docs/interfaces/fulfilment-hub-v1.md`](../../docs/interfaces/fulfilment-hub-v1.md).

The fulfilment hub's value is that one warehouse adapter is swappable for another. That only holds if every adapter keeps the same promises, and most of those promises are invisible to a type checker: an op that blocks on a warehouse round trip, a `push_order` that ships twice on a retry, money that arrives as `25.50` instead of `2550`, a timestamp in local time. This package drives an adapter's real handler map and checks each one.

```ts
import { describeConformance } from '@sprigr/apps-fulfilment-conformance/vitest';
import handlers from '../src/handlers/provider';
import manifest from '../sprigr-app.json';
import { fakeEnv } from './__helpers__/fake-env';

const env = fakeEnv();

describeConformance({
  role: 'fulfilment_provider',
  slug: 'mock-warehouse',
  handlers,
  manifest,
  env: () => env,
  vendorCalls: () => env.vendor.calls,
});
```

## What it checks

Per op, for all seven `fulfilment_provider` ops and all thirteen `order_source` ops:

- the handler exists under the contract name `<slug_with_underscores>_<op>` and does not throw;
- it answers inside a wall-clock budget (default 20 s, the 25 s dispatch budget minus headroom), raced rather than measured, so a hung op reports instead of hanging the suite;
- its output matches the contract shape, including the parts a JSON Schema keyword cannot say: integer minor units, integer quantities, ISO 8601 **UTC** timestamps, ISO 4217 and ISO 3166-1 alpha-2 codes, and the closed `order.status` enum;
- a **write** op acknowledges with its own interface's status set and nothing else, carries a `reason` when it refuses, and carries its ref (`provider_ref`) when it does not. The two sets differ on purpose (contract section 7, clarification 2): a `fulfilment_provider` acks `accepted | queued | rejected` and reports transient trouble later through `provider.order.error { retryable: true }`; an `order_source` has no such event, so it acks `accepted | rejected | error` and says `error` inline for a failure the hub may retry. Returning the other interface's spelling fails the harness, because the hub reads the value to decide whether to retry.

Behaviourally:

- **`push_order` is idempotent on `fulfilment_request_id`**: a repeat call returns the same `provider_ref` and makes **no** vendor call, while a distinct id gets its own ref and **does** reach the vendor. Both halves are required, because an adapter that never calls its vendor at all would otherwise pass the first.
- **`describe` reports the install's own slug** and a complete `capabilities` block, and behaviour that contradicts a declared capability fails (a `supports_cancel: false` adapter must refuse `cancel_order` with an ack, not accept it).

`checkAdapterManifest(manifest, role)` covers the declaration half, which no runtime suite can see: every contract op claimed with a `provides` tag pinned at `1.0.0`, tool names carrying the slug prefix, each tagged tool present in `tools[]` with a handler and `effects: 'write'` on the write ops, every contract op claimed, no mistyped event name, and the outcome events the claimed write ops imply declared in `events.emits[]`.

Source events are spelled `source.*`, not `order_source.*`: the platform's publish-time event-name check allows no underscore in the first dotted segment, and `sprigr app validate` does not run it, so the wrong spelling passes validate and is refused at publish. The manifest check is where that is caught before you get there.

## Reading the report

Every entry point returns `{ ok, checks: [{ name, ok, detail }] }`. A check is never skipped: a condition the harness could not exercise fails and says what to supply. `get_order` is the usual one, since only the adapter knows an order id its own store holds:

```ts
runOrderSourceConformance(handlers, {
  slug: 'mock-order-source',
  env: () => env,
  fixtures: { get_order: { source_ref: 'shop_1001' } },
});
```

`formatReport(report)` renders one line per check for a CI log.

## Notes

- `opts.env()` is called **once** per suite run and the same value is passed to every op. Idempotency is stateful; a fresh env per call would make it untestable.
- The suite asserts shape, budget and the ack enum, not business outcome. A stateful adapter that refuses an op still conforms, as long as it refuses with `rejected` plus a reason rather than throwing or inventing a status.
- The main entry is dependency-free and safe to import inside a Worker. The `vitest` binding is a separate entry point for that reason.

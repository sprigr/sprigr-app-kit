# Mock Warehouse (`mock-warehouse`)

A deterministic implementer of **`fulfilment-hub/fulfilment_provider` v1.0.0** ([contract](../../docs/interfaces/fulfilment-hub-v1.md)). Two jobs:

1. **The hub's shakedown fixture.** Install it next to the hub on a brand tenant and the whole order flow can be driven end to end with no 3PL account, no credentials and no network: every push is accepted, and `mock_warehouse_advance` fires the callbacks a real warehouse would.
2. **The worked reference for a real warehouse adapter.** Every rule the contract states is visible in about 250 lines of handler.

## The shape a real adapter copies

- **`push_order` acknowledges, it does not fulfil.** It returns `{ status: 'queued', provider_ref }` and stops. The hub learns the outcome from `provider.order.accepted`, which arrives later. An adapter that waits for the warehouse inside the op blows the 25 s dispatch budget the first time the 3PL is slow, and fails the conformance harness.
- **Idempotency is a read, not a lock.** `push_order` reads `mock_warehouse_requests` by `fulfilment_request_id` and returns the stored `provider_ref` on a hit, so neither the vendor nor D1 is touched twice. The hub's outbox is at-least-once; without this a redelivery ships the order again.
- **`provider_ref` is `mw_<fulfilment_request_id>`.** Deterministic on purpose: a shakedown can predict every id it will see, and an assertion that reads `mw_fr_01J...` is stable across runs.
- **One D1 table, written on a miss.** No per-event audit rows. Advancing a request rewrites the one row and reports through `env.SPRIGR.log()`.
- **Every event payload carries `adapter_slug` and `interface_version`**, so the hub can attribute a row to a binding.

## Driving it

```
mock_warehouse_advance { fulfilment_request_id: 'fr_...' }                 -> accepted, then shipped
mock_warehouse_advance { fulfilment_request_id: 'fr_...', to: 'accept' }   -> provider.order.accepted only
mock_warehouse_advance { fulfilment_request_id: 'fr_...', to: 'ship',
                         carrier: 'DHL', tracking_number: 'D1' }           -> provider.shipment.created
mock_warehouse_advance { fulfilment_request_id: 'fr_...', to: 'cancel' }   -> provider.order.cancelled
```

`get_stock` answers from a fixed fixture (`src/lib/stock.ts`): `mw_bne` and `mw_syd`, four SKU rows, integer quantities.

## Tests

```
pnpm -F mock-warehouse test
```

`__tests__/conformance.test.ts` runs the full [`@sprigr/apps-fulfilment-conformance`](../../packages/fulfilment-conformance) suite against this app's real handler map plus its manifest. `__tests__/advance.test.ts` covers the two things the harness cannot reach: the advance lever's event sequence, and the idempotency record underneath `push_order`.

There is no `DB` binding in a unit test, so `depsFor(env)` hands the handlers an in-memory store and a call-counting stand-in vendor. On the platform `env.DB` is always bound and the same handlers run against per-install D1; the fallback is unreachable in production.

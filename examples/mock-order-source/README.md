# Mock Order Source (`mock-order-source`)

A deterministic implementer of **`fulfilment-hub/order_source` v1.0.0** ([contract](../../docs/interfaces/fulfilment-hub-v1.md)). Two jobs:

1. **The selling-system half of the hub's shakedown fixture.** Install it next to the hub and `mock-warehouse`, call `mock_order_source_place_order`, and the hub has a real routing trigger to act on with no Shopify store, no Magento install and no credentials.
2. **The worked reference for a real order-source adapter.** Every op is implemented against this install's own D1, which is what a real adapter does against its selling system's API.

## The shape a real adapter copies

- **The store keeps the contract's field names.** `mock_order_source_orders` and `_lines` are the canonical `order` / `order_line` columns. A store that keeps some other model has to translate on every read, and that is where field drift starts.
- **`order_id` goes out empty.** The hub assigns it; an order source never invents one.
- **Money is integer minor units, quantities are integers, timestamps are ISO 8601 UTC.** `set_stock_level` refuses a fractional `on_hand` rather than rounding it.
- **`source.request.submitted` is THE routing trigger.** `place_order` fires it after `order.created`; so does the new half of a `split`. A hub that never sees it never routes.
- **Every write op acknowledges with `accepted | rejected | error`.** Not the provider interface's `accepted | queued | rejected`: the two enums differ on purpose (contract section 7, clarification 2). `error` means the hub may retry, `rejected` is terminal, and `release` returns `error` when the `source.request.hold_released` event could not be delivered. The ops record the new state and otherwise do NOT enforce a state machine, because the hub owns that and a fixture that second-guesses it would make the hub's own transitions untestable.
- **`add_note` appends.** It never replaces the notes or tags already on the order.

## Seeded on install

Migration 0001 writes one order (`mos_seed_1` / `MOS-1001`, two lines, AUD 45.00), one submitted request (`mos_seed_1_r1`) and two locations (`mos_loc_bne`, `mos_loc_syd`). A fresh install can answer `get_order` and drive the whole request lifecycle before anyone has placed anything. `src/lib/records.ts` holds the same values for the in-memory store and `__tests__/seed.test.ts` fails if the two drift.

## Driving it

```
mock_order_source_place_order { source_number: 'MOS-2001', sku: 'CONF-SKU-1', quantity: 2 }
  -> order mos_mos_2001, request mos_mos_2001_r1
  -> source.order.created, then source.request.submitted
```

Ids are derived from `source_number`, so a shakedown script knows every id before it runs.

## Tests

```
pnpm -F mock-order-source test
```

`__tests__/conformance.test.ts` runs the full [`@sprigr/apps-fulfilment-conformance`](../../packages/fulfilment-conformance) suite against this app's real handler map plus its manifest, with fixtures pointed at the seeded ids so every op lands on a real row. The other two files cover what the harness cannot reach: the place-order lever's event payloads, the split and hold/release effects on the store, and the seed's two copies.

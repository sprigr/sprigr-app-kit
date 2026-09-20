# Fulfilment hub interfaces, version 1 (contract)

This is the contract every fulfilment-hub implementer builds to: the hub app, the order-source adapters, the fulfilment-provider adapters, the conformance harness and the scaffold templates. It is decision 0088 in sprigr-team made concrete. The hub app's manifest (`apps/fulfilment-hub/sprigr-app.json` in sprigr-apps) carries the machine-readable definitions; this page is the prose that goes with them, and when they disagree the manifest wins and this page is fixed.

Mechanism: decision 0077 (sprigr-team `docs/decisions/implemented/0077-...`), platform guide `guide-marketplace-interfaces`, kit samples `examples/showcase`, `examples/showcase-consumer`, `examples/contact-mirror`.

## 1. Roles

| Role | Installed where | Manifest | Talks to |
|---|---|---|---|
| **Hub** (`fulfilment-hub`) | per brand tenant | defines both interfaces; `app_dependencies` requires both with `{ provides }` | adapters only, via `env.SPRIGR.grants.providers` + `env.SPRIGR.invoke`; never a vendor API |
| **Order-source implementer** | per brand tenant | tags tools with `provides: { interface: 'fulfilment-hub/order_source', op }`; emits the source events | its selling system and the hub |
| **Fulfilment-provider implementer** | per brand tenant (brand-direct) | tags tools with `provides: { interface: 'fulfilment-hub/fulfilment_provider', op }`; emits the provider events | its warehouse or 3PL API and the hub |

**Where an implementer lives (ruling 2026-09-15).** When a first-party integration app for the system already exists (`shopify`, `starshipit`, `cin7-core`), that app implements the interface ITSELF: it adds the interface ops as `internal: true` tools named `<slug>_<op>`, tags them, and emits the events from the same code paths that already handle the vendor's webhooks. A brand installs one app per system. A separate `<x>-order-source` / `<x>-fulfilment` adapter app exists only for a system with no first-party app (JSJ / Sinotrans is the public `sinotrans` app) or for a third party publishing against the contract. The separate `shopify-order-source` and `starshipit-fulfilment` apps built on 2026-09-15 were folded into their host apps the same day.

Rules that make an adapter interchangeable (from decision 0088, enforced by the conformance harness):

- **Every op that reaches a third party is asynchronous.** It returns inside the 25 s dispatch budget with `{ status: 'accepted' | 'queued' | 'rejected', provider_ref?, reason? }` and the outcome arrives as an event. An op that blocks on a warehouse round trip fails the harness.
- **`push_order` is idempotent on `fulfilment_request_id`.** A repeat call returns the same `provider_ref` and does not call the warehouse again.
- **Money is integer minor units plus an ISO 4217 code** (`amount_minor`, `currency`). **Quantities are integers. Timestamps are ISO 8601 UTC strings.** Decimal conversion happens inside the adapter that talks to a decimal API.
- **Identifiers cross the boundary as opaque strings.** `source_ref` is whatever the selling system calls the thing; `provider_ref` is whatever the warehouse calls it. The hub correlates on its own `fulfilment_request_id` and `order_id`.
- **`shipment.event.stage` is a closed enum.** An adapter maps its carrier's vocabulary onto it.
- **An adapter declares its capabilities** in a `capabilities` object returned by `describe` (both interfaces). The hub reads these to choose a path; it never discovers a limit from error text.
- **Provider-specific brand configuration lives in the adapter's install config or secrets, never in the hub.** JSJ's per-brand user code is the case in point.
- **Adapters talk to their own API and to the hub, nothing else.** An adapter never invokes another adapter and never exposes a hot agent tool.
- **Tool naming**: a `provides`-tagged tool is `<adapter_slug_with_underscores>_<op>` (publish refuses anything else) and is also in `tools[]` with a handler.

Events: adapters emit through `env.SPRIGR.emit` with the names below; the hub subscribes to them in `events.subscribes[]`. Payloads carry `adapter_slug` and `interface_version` so the hub can attribute a row to a binding. Same-tenant delivery only in v1.

## 2. Canonical records (the hub's collections)

All on the decision 0030 field types (`string | number | date | boolean`). The hub owns them as `env.SPRIGR.collections` under names prefixed `fh-` (the hub's reserved segment; adapters never write them; the platform's collection `name_suffix` rule forbids underscores, so it is `fh-order`, `fh-order-line`, and so on). Adapters SEND these shapes in op results and event payloads; the hub STORES them.

### `order`
| field | type | notes |
|---|---|---|
| `order_id` | string | hub id, `ord_<ulid>` |
| `source_adapter` | string | adapter slug |
| `source_ref` | string | selling-system order id (opaque) |
| `source_number` | string | human order number (`PY43028`) |
| `channel` | string | `shopify`, `magento`, `cin7`, `amazon`, `tiktok` |
| `status` | string | `received`, `routing`, `pushed`, `accepted`, `shipped`, `delivered`, `cancelled`, `failed`, `held` |
| `placed_at` | date | |
| `currency` | string | ISO 4217 |
| `total_minor` | number | |
| `customer_email` | string | sensitivity `pii` |
| `ship_to_json` | string | JSON of the `address` shape below |
| `tags_json` | string | JSON string[] |
| `hold_reason` | string | empty when not held |
| `updated_at` | date | |

### `order_line`
| field | type |
|---|---|
| `order_id` | string |
| `line_id` | string |
| `source_line_ref` | string |
| `sku` | string |
| `title` | string |
| `quantity` | number |
| `unit_price_minor` | number |
| `currency` | string |
| `requires_shipping` | boolean |

### `fulfilment_request` (a routing of some lines of an order to one provider warehouse)
| field | type | notes |
|---|---|---|
| `fulfilment_request_id` | string | `fr_<ulid>`; the idempotency key for `push_order` |
| `order_id` | string | |
| `source_request_ref` | string | e.g. the Shopify FulfillmentOrder id |
| `provider_adapter` | string | adapter slug |
| `provider_install_id` | string | binding install |
| `warehouse_key` | string | from `list_warehouses` |
| `provider_ref` | string | provider's id once accepted |
| `status` | string | `pending`, `pushed`, `accepted`, `rejected`, `error`, `shipped`, `cancelled`, `cancel_refused` |
| `lines_json` | string | JSON `[{ line_id, sku, quantity }]` |
| `attempts` | number | |
| `last_error` | string | |
| `pushed_at` | date | |
| `updated_at` | date | |

### `shipment`
| field | type |
|---|---|
| `shipment_id` | string |
| `fulfilment_request_id` | string |
| `order_id` | string |
| `provider_adapter` | string |
| `provider_ref` | string |
| `carrier` | string |
| `tracking_number` | string |
| `tracking_url` | string |
| `lines_json` | string |
| `weight_grams` | number |
| `dimensions_json` | string |
| `shipped_at` | date |
| `delivered_at` | date |
| `written_back` | boolean |

### `shipment_event`
| field | type | notes |
|---|---|---|
| `shipment_id` | string | |
| `stage` | string | closed enum: `label_printed`, `departed_warehouse`, `first_scan`, `destination_arrival`, `delivered`, `exception` |
| `occurred_at` | date | |
| `location` | string | |
| `provider_event_ref` | string | dedup key from the adapter |
| `detail` | string | |

### `stock_level`
| field | type |
|---|---|
| `provider_adapter` | string |
| `warehouse_key` | string |
| `sku` | string |
| `on_hand` | number |
| `reserved` | number |
| `held` | number |
| `snapshot_at` | date |

### `exception`
| field | type | notes |
|---|---|---|
| `exception_id` | string | |
| `order_id` | string | |
| `fulfilment_request_id` | string | |
| `kind` | string | `short_pick`, `address_invalid`, `prohibited_item`, `provider_error`, `routing_timeout`, `unknown` |
| `severity` | string | `info`, `warning`, `critical` |
| `status` | string | `open`, `acknowledged`, `resolved`, `expired` |
| `raised_by` | string | adapter slug or `hub` |
| `message` | string | |
| `deadline_at` | date | |
| `resolution` | string | |
| `updated_at` | date | |

### `location` (a provider warehouse mapped to a source location)
| field | type |
|---|---|
| `provider_adapter` | string |
| `warehouse_key` | string |
| `name` | string |
| `country` | string |
| `source_adapter` | string |
| `source_location_ref` | string |
| `enabled` | boolean |

### `address` (embedded JSON, not a collection)
`{ name, company, line1, line2, city, region, postcode, country (ISO 3166-1 alpha-2), phone, email }`, all strings, missing keys omitted.

## 3. `fulfilment-hub/order_source` v1.0.0

**1.4.0 adds `update_address`.** An operator looking at a wrong ship-to in the hub can correct it and have the selling system corrected with it, which is what the ASCS operator connector's `edit_routing_address` did before the hub existed. It is a PARTIAL update: only the address fields supplied change, so correcting a street number cannot clobber a name. `address.email` is not a shipping-address field in the selling systems we target, so a source may ignore it; the hub keeps the customer email on its own record. A source that cannot implement the op answers `{ status: 'rejected', reason: 'unsupported' }` and reports `supports_address_update: false` (or omits the flag, which reads the same); a source that can, but not for this order any longer, answers `rejected` with its own reason, and the hub shows that text to the operator. Per clarification 9 the refusal must be an ACK, never a throw.

`consumers: any`. Every op takes and returns JSON objects; `input_schema` / `output_schema` in the manifest are the source of truth for shapes.

| op | effects | input | output |
|---|---|---|---|
| `describe` | read | `{}` | `{ adapter_slug, channel, capabilities: { supports_hold, supports_split, supports_cancel, supports_stock_write, supports_address_update?, request_model: 'fulfilment_orders' \| 'orders' } }` |
| `list_locations` | read | `{}` | `{ locations: [{ source_location_ref, name, country, active }] }` |
| `register_location` | write | `{ warehouse_key, name, country, address? }` | `{ status, source_location_ref?, reason? }` |
| `get_order` | read | `{ source_ref }` | `{ found, order?, lines?: order_line[] }` (canonical shapes, `order_id` empty: the hub assigns it) |
| `accept_request` | write | `{ source_request_ref }` | `{ status, reason? }` |
| `reject_request` | write | `{ source_request_ref, reason }` | `{ status }` |
| `mark_shipped` | write | `{ source_request_ref, source_ref, carrier, tracking_number, tracking_url?, lines: [{ source_line_ref, quantity }], notify_customer }` | `{ status, source_fulfilment_ref?, reason? }` |
| `hold` | write | `{ source_request_ref, reason }` | `{ status, reason? }` |
| `release` | write | `{ source_request_ref }` | `{ status, reason? }` |
| `cancel` | write | `{ source_request_ref, reason }` | `{ status, reason? }` |
| `split` | write | `{ source_request_ref, lines: [{ source_line_ref, quantity }] }` | `{ status, new_source_request_ref?, reason? }` |
| `set_stock_level` | write | `{ source_location_ref, sku, on_hand }` | `{ status, reason? }` |
| `add_note` | write | `{ source_ref, note, tags?: string[] }` | `{ status }` |
| `update_address` | write | `{ source_ref, ship_to: address, reason? }` | `{ status, reason? }` (1.4.0; PARTIAL update, only supplied fields change) |

Events (the adapter emits; the hub subscribes):

| event | payload |
|---|---|
| `source.order.created` | `{ adapter_slug, order, lines }` |
| `source.order.updated` | `{ adapter_slug, order, lines, changed: string[] }` |
| `source.order.cancelled` | `{ adapter_slug, source_ref, reason }` |
| `source.request.submitted` | `{ adapter_slug, source_ref, source_request_ref, source_location_ref, lines: [{ source_line_ref, sku, quantity }] }` (THE routing trigger) |
| `source.request.cancellation_submitted` | `{ adapter_slug, source_ref, source_request_ref, reason }` |
| `source.request.hold_released` | `{ adapter_slug, source_ref, source_request_ref }` |
| `source.stock.changed` | `{ adapter_slug, source_location_ref, sku, on_hand }` |

## 4. `fulfilment-hub/fulfilment_provider` v1.0.0

`consumers: any`.

| op | effects | input | output |
|---|---|---|---|
| `describe` | read | `{}` | `{ adapter_slug, capabilities: { supports_cancel, supports_split, supports_hold, tracking_mode: 'push' \| 'poll' \| 'scrape', stock_mode: 'snapshot' \| 'delta' \| 'none', countries: string[] } }` |
| `list_warehouses` | read | `{}` | `{ warehouses: [{ warehouse_key, name, country, cutoff_local_time?, active }] }` |
| `push_order` | write | `{ fulfilment_request_id, order_id, source_number, warehouse_key, ship_to: address, customer_email?, lines: [{ line_id, sku, title, quantity, unit_price_minor, currency }], currency, total_minor, notes?, callback_hint? }` | `{ status: 'accepted' \| 'queued' \| 'rejected', provider_ref?, reason? }` (idempotent on `fulfilment_request_id`) |
| `cancel_order` | write | `{ fulfilment_request_id, provider_ref, reason }` | `{ status: 'accepted' \| 'queued' \| 'rejected', reason? }` (outcome as `provider.order.cancelled` or `provider.order.cancel_refused`) |
| `get_order_status` | read | `{ fulfilment_request_id, provider_ref }` | `{ status, provider_status_raw?, tracking?: { carrier, tracking_number, tracking_url } }` |
| `get_stock` | read | `{ warehouse_key?, skus?: string[] }` | `{ levels: stock_level[] }` |
| `health` | read | `{}` | `{ ok, credentials_ok, last_callback_at?, breaker_open, detail? }` |

Events:

| event | payload |
|---|---|
| `provider.order.accepted` | `{ adapter_slug, fulfilment_request_id, provider_ref, warehouse_key }` |
| `provider.order.rejected` | `{ adapter_slug, fulfilment_request_id, provider_ref?, reason }` (not retryable) |
| `provider.order.error` | `{ adapter_slug, fulfilment_request_id, reason, retryable: boolean }` |
| `provider.order.cancelled` | `{ adapter_slug, fulfilment_request_id, provider_ref }` |
| `provider.order.cancel_refused` | `{ adapter_slug, fulfilment_request_id, provider_ref, reason }` |
| `provider.shipment.created` | `{ adapter_slug, fulfilment_request_id, provider_ref, shipment: { provider_shipment_ref, carrier, tracking_number, tracking_url?, lines, weight_grams?, dimensions?, shipped_at } }` |
| `provider.shipment.event` | `{ adapter_slug, provider_shipment_ref, tracking_number, stage, occurred_at, location?, provider_event_ref, detail? }` |
| `provider.stock.snapshot` | `{ adapter_slug, warehouse_key, snapshot_at, full: boolean, levels: [{ sku, on_hand, reserved }] }` |
| `provider.exception.raised` | `{ adapter_slug, fulfilment_request_id, kind, severity, message, provider_exception_ref }` |
| `provider.exception.cleared` | `{ adapter_slug, provider_exception_ref, resolution }` |

## 5. What the hub owns

Routing rules (data the brand edits; evaluated by the hub per `source.request.submitted`: by destination country, channel, tag, SKU eligibility, stock, then provider and warehouse), the state machine `received -> routing -> pushed -> accepted -> shipped -> delivered` with `cancelled`, `failed` and `held` off-ladder, an outbox with an atomic claim latch so at-least-once event delivery cannot double-push, routing timeouts and stuck-request sweeps, the exception ledger with severity, deadline and escalation, the backorder and presale engine (allocations, hold gate, release, mixed-order split through `order_source.split`), stock reconciliation (`sellable = on_hand - held - reserved` pushed to every bound order source), the brand dashboard (Orders, Shipments, Inventory, Exceptions, Backorders, Reports, Settings), agent tools, a daily shipment report snapshot, and decision points for ambiguous routing and exception handling. Tariffs and statements are a later module.

The hub never names an adapter slug in code. It lists providers with `env.SPRIGR.grants.providers(interfaceId)`, calls `describe` once per provider install (cached in D1 with the binding's `install_id`), and dispatches ops by the bound tool names. Every write op through a provider is wrapped: claim the outbox row, invoke, record the ack, wait for the event.

## 6. Versioning

`1.0.0` is the first published version of both. Adding an optional input field, an output field or an event is a minor. Removing or renaming an op, removing or narrowing a field, or making an input required is a new major. Adapters pin `version: '1.0.0'` in their `provides` tags and the hub requires `^1`.

## 7. Clarifications (binding, added after the first implementer pass)

1. **Source event names are `source.*`, not `order_source.*`.** The platform's publish-time `EVENT_NAME_REGEX` allows no underscore in the first dotted segment (`shopify.orders.create`, `provider.order.accepted` pass; `order_source.order.created` is refused at publish, and `sprigr app validate` does not run that check). The seven source events are therefore `source.order.created`, `source.order.updated`, `source.order.cancelled`, `source.request.submitted`, `source.request.cancellation_submitted`, `source.request.hold_released`, `source.stock.changed`. Payloads are unchanged. The tables above are already updated.
2. **Op ack statuses.** `order_source` write ops return `status: 'accepted' | 'rejected' | 'error'` (`error` = a transient failure the hub may retry; `rejected` = terminal, do not retry). `fulfilment_provider` write ops keep `accepted | queued | rejected` and signal transient trouble through `provider.order.error { retryable: true }`. Read ops on both interfaces return their data shape directly.
3. **`source_line_ref` on `source.request.submitted` is the request-scoped line id** (for Shopify, the FulfillmentOrderLineItem gid), because that is what the source's fulfil, cancel and split calls take; `get_order` lines carry the order-scoped line id. Both are opaque to the hub; the hub passes back whichever it was given for the call it makes.
4. **`list_locations[].country`** may be a display name when the source cannot provide ISO alpha-2; the hub matches `location` rows on `source_location_ref`, never on country.
5. **`order_line.requires_shipping`** defaults to `true` when the source does not project it.

The rest were added with the conformance harness (`@sprigr/apps-fulfilment-conformance`). Each is a reading of a rule already in sections 1 to 4 that the prose left open; the harness has to pick one, so it is written down rather than left to each adapter. Where one is an addition rather than a reading, it says so.

6. **A `rejected` ack carries a non-empty `reason`, and so does an `order_source` `error`.** The hub has no other way to tell a refusal from a bug, and section 1 says it never discovers a limit from error text. `accepted` and `queued` may omit it.

7. **A non-rejected `push_order` ack carries a non-empty `provider_ref`.** The hub correlates the later `provider.*` event on it, so an accepted push with no ref leaves the request uncorrelatable. `cancel_order` does not need one: it is given the ref.

8. **`describe().adapter_slug` is the installed app's own slug.** The hub stamps rows with it and payloads repeat it; a describe that reports something else silently misattributes every row from that binding.

9. **Behaviour may not contradict a declared capability.** An adapter whose `capabilities` say `supports_cancel: false` must still answer `cancel_order` with an ack, and that ack must be `rejected`. Accepting it would leave the hub waiting for a `provider.order.cancelled` that never arrives. Same for `supports_split` on `order_source.split` and `supports_stock_write` on `set_stock_level`. An op is never absent and never throws: a capability the adapter lacks is a refusal, not a missing binding.

10. **Every canonical field in section 2 is required on the wire, with an empty string where the value is absent.** `get_order` returns `order.order_id` as `''` (the hub assigns it) and `order.hold_reason` as `''` when the order is not held, rather than omitting either. An optional field is one the table marks optional; `list_warehouses`'s `cutoff_local_time` and `get_order_status`'s `tracking` are the examples.

11. **"ISO 8601 UTC" means a `Z` suffix.** A local-offset stamp (`2026-09-15T10:00:00+10:00`) is refused. The hub stores these on decision 0030 `date` fields, and two adapters disagreeing about the zone is exactly the silent skew the contract exists to stop.

12. **An adapter claims EVERY op of the interface it implements.** The hub dispatches by op and cannot tell a missing binding from a broken adapter, so a partial implementer is not interchangeable. The harness's manifest check fails on an unclaimed op; `checkAdapterManifest(manifest, role, { allowUnclaimedOps: [...] })` is the deliberate, named escape hatch for an adapter that genuinely cannot.

13. **Declaring outcome events is part of claiming a write op** (an addition, not a reading). Every write op acknowledges asynchronously, so the hub only ever learns the outcome from an event, and the platform drops an emit the manifest does not declare. The harness therefore requires: claiming `push_order` means declaring `provider.order.accepted`, `.rejected` and `.error` in `events.emits[]`; claiming `cancel_order` means declaring `provider.order.cancelled` and `.cancel_refused`; and any `order_source` adapter declares `source.order.created` and `source.request.submitted`. Declaring an event the adapter does not yet emit is fine and expected; emitting one it has not declared is not possible.

14. **The dispatch budget the harness enforces is 20 s**, against the 25 s section 1 allows, so an op that only just fits in CI is caught before it only just fails in production. Callers can raise or lower it with `opts.timeBudgetMs`.
15. **Collection names are `fh-*`** (`fh-order`, `fh-order-line`, `fh-fulfilment-request`, `fh-shipment`, `fh-shipment-event`, `fh-stock-level`, `fh-exception`, `fh-location`): the platform's collection `name_suffix` rule forbids underscores. The record names in section 2 are the logical names; the hub keeps the logical-to-suffix map in one file.
16. **`set_stock_level.on_hand` means "the quantity the selling system should treat as available to sell at that location".** The hub computes it as the provider's `on_hand` minus the hub's own `held`, and NOT minus the provider's `reserved`: the selling system's committed count already covers open orders, so subtracting reserved too double-counts and undersells (the ASCS brand app's v1.21.2 precedent). An order-source adapter writes that number as the source's available quantity without adding anything back.

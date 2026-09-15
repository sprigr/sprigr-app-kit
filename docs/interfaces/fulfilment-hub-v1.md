# Fulfilment hub interfaces, version 1 (contract)

This is the contract every fulfilment-hub implementer builds to: the hub app, the order-source adapters, the fulfilment-provider adapters, the conformance harness and the scaffold templates. It is decision 0088 in sprigr-team made concrete. The hub app's manifest (`apps/fulfilment-hub/sprigr-app.json` in sprigr-apps) carries the machine-readable definitions; this page is the prose that goes with them, and when they disagree the manifest wins and this page is fixed.

Mechanism: decision 0077 (sprigr-team `docs/decisions/implemented/0077-...`), platform guide `guide-marketplace-interfaces`, kit samples `examples/showcase`, `examples/showcase-consumer`, `examples/contact-mirror`.

## 1. Roles

| Role | Installed where | Manifest | Talks to |
|---|---|---|---|
| **Hub** (`fulfilment-hub`) | per brand tenant | defines both interfaces; `app_dependencies` requires both with `{ provides }` | adapters only, via `env.SPRIGR.grants.providers` + `env.SPRIGR.invoke`; never a vendor API |
| **Order-source adapter** (`<x>-order-source`) | per brand tenant | tags tools with `provides: { interface: 'fulfilment-hub/order_source', op }`; emits the source events | its selling system (via the platform integration app or the vendor API) and the hub |
| **Fulfilment-provider adapter** (`<x>-fulfilment`) | per brand tenant (brand-direct) | tags tools with `provides: { interface: 'fulfilment-hub/fulfilment_provider', op }`; emits the provider events | its warehouse or 3PL API and the hub |

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

All on the decision 0030 field types (`string | number | date | boolean`). The hub owns them as `env.SPRIGR.collections` under names prefixed `fh_` (the hub's reserved segment; adapters never write them). Adapters SEND these shapes in op results and event payloads; the hub STORES them.

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

`consumers: any`. Every op takes and returns JSON objects; `input_schema` / `output_schema` in the manifest are the source of truth for shapes.

| op | effects | input | output |
|---|---|---|---|
| `describe` | read | `{}` | `{ adapter_slug, channel, capabilities: { supports_hold, supports_split, supports_cancel, supports_stock_write, request_model: 'fulfilment_orders' \| 'orders' } }` |
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

Events (the adapter emits; the hub subscribes):

| event | payload |
|---|---|
| `order_source.order.created` | `{ adapter_slug, order, lines }` |
| `order_source.order.updated` | `{ adapter_slug, order, lines, changed: string[] }` |
| `order_source.order.cancelled` | `{ adapter_slug, source_ref, reason }` |
| `order_source.request.submitted` | `{ adapter_slug, source_ref, source_request_ref, source_location_ref, lines: [{ source_line_ref, sku, quantity }] }` (THE routing trigger) |
| `order_source.request.cancellation_submitted` | `{ adapter_slug, source_ref, source_request_ref, reason }` |
| `order_source.request.hold_released` | `{ adapter_slug, source_ref, source_request_ref }` |
| `order_source.stock.changed` | `{ adapter_slug, source_location_ref, sku, on_hand }` |

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

Routing rules (data the brand edits; evaluated by the hub per `order_source.request.submitted`: by destination country, channel, tag, SKU eligibility, stock, then provider and warehouse), the state machine `received -> routing -> pushed -> accepted -> shipped -> delivered` with `cancelled`, `failed` and `held` off-ladder, an outbox with an atomic claim latch so at-least-once event delivery cannot double-push, routing timeouts and stuck-request sweeps, the exception ledger with severity, deadline and escalation, the backorder and presale engine (allocations, hold gate, release, mixed-order split through `order_source.split`), stock reconciliation (`sellable = on_hand - held - reserved` pushed to every bound order source), the brand dashboard (Orders, Shipments, Inventory, Exceptions, Backorders, Reports, Settings), agent tools, a daily shipment report snapshot, and decision points for ambiguous routing and exception handling. Tariffs and statements are a later module.

The hub never names an adapter slug in code. It lists providers with `env.SPRIGR.grants.providers(interfaceId)`, calls `describe` once per provider install (cached in D1 with the binding's `install_id`), and dispatches ops by the bound tool names. Every write op through a provider is wrapped: claim the outbox row, invoke, record the ack, wait for the event.

## 6. Versioning

`1.0.0` is the first published version of both. Adding an optional input field, an output field or an event is a minor. Removing or renaming an op, removing or narrowing a field, or making an input required is a new major. Adapters pin `version: '1.0.0'` in their `provides` tags and the hub requires `^1`.

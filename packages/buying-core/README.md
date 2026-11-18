# @sprigr/apps-buying-core

Pure buying maths for inventory apps. No I/O, no platform calls: every function takes plain rows and returns plain results, each with a reason code.

- `forecast`, `backtest`: ten demand methods and a rolling-origin tournament that picks one per class and velocity band.
- `buyer-metrics`: velocity, forward cover, stockout risk tiers, buy quantity.
- `buy-rules`: slow-seller, new-product and maximum-cover limits.
- `buy-plan`: order, expedite, skip or review per SKU, inside a budget.
- `otb`: open-to-buy.
- `markdown`: markdown candidates.
- `newsvendor`: one-shot seasonal quantity.
- `po-scoring`: purchase-order grades and supplier scorecards.

## What the caller does first

- **Exclusions.** The package applies none. Before calling `scorePo`, `rollupSuppliers` or the SKU functions, the caller drops the rows its exclusion list names. The list has six dimensions (`sku`, `supplier_ref`, `location_id`, `class_1`, `class_2`, `brand`), and a `supplier_ref` entry matches either of a supplier's two codes.
- **Purchase-order rows.** `PurchaseOrderRow` is one row per purchase order. The caller rolls order lines up to one row per order; the roll-up rule is set with sprigr-team#16078.

## Not in this package yet

- **Realised lead time from receipts.** `realized_lead_time_days` is the days from `ordered_date` to `latest_eta` once anything has been received. It is the latest expected date, not a receipt date, so on a partly received order it reflects the units still due (sprigr-team#16078).
- **A window and a cap on supplier lead times.** `lead_time_p50_days` and `lead_time_p90_days` take every positive value. They do not limit lines to a recent window or drop values over a cap (sprigr-team#16078).
- **A measured lead time in the buy quantity.** `resolveLeadTime` uses a brand or SKU override, then a class override, then the default. A measured supplier lead time does not reach `deriveSkuMetrics` (sprigr-team#16127).

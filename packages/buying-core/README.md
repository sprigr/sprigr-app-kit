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
- `performance`: proven, promising, underperforming and run-down tiers from sales, and from ad spend when supplied.
- `lead-time`: realised lead time per supplier from order lines and receipts.

## Breaking changes in 0.2.0

- `PoScored.margin_per_landed_dollar` is now `margin_per_landed_cost`, and the deprecated `gmroi` alias is gone. The supplier scorecard's `avg_gmroi` is now `avg_margin_per_landed_cost`.
- Reason code `MARGIN_PER_DOLLAR_LOW` is now `MARGIN_PER_LANDED_LOW`.
- Reason codes `AGED_90` and `AGED_180` are now `AGED_FIRST` and `AGED_SECOND`. Where each bucket starts is the `aged_days` option; the detail text carries the real age.
- `BacktestResult` gains `velocity_split_units_per_month`. A result built by 0.1.0 has none, and `runLiveForecast` then bands on the default 8.

## What the caller does first

- **Exclusions.** The caller drops excluded rows before calling; the package applies no exclusions.
- **Purchase-order rows.** `PurchaseOrderRow` is one row per purchase order. The caller rolls order lines up to one row per order; the roll-up rule is not set by this package and is tracked separately.

## What the caller supplies

Nothing below has a built-in value. Left out, the feature does nothing.

- **Brand.** The row's `brand` attribute. The package never reads a brand out of a SKU id. A row with no brand matches no brand override and no brand budget, and falls through to the class override, then the default.
- **Labels.** A row may carry a `label`. `label_roles` maps the caller's own label values to one of two roles: `priority` (a stocked-out row sorts first in the buy plan) and `run_down` (no EOQ top-up). With no labels or no map, nothing is prioritised or blocked.
- **No labeller of your own.** Call `classifyPerformance` and pass each row's `role` to the buy plan and the EOQ guard. With your own labels, map them with `label_roles`; a mapped label wins over the row's role.
- **EOQ costs.** `handling_cost_per_line` and `eoq_fallback_unit_cost` are in the caller's currency. Without a handling cost there is no EOQ top-up; without a fallback cost an unpriced SKU gets none.
- **Seasonal classes and the profitability curve.** `seasonal_classes` and `profitability_coverage_adjust` start empty.
- **Active rows.** `is_active` on a buy-plan or markdown row; a row that does not say is treated as active.

## Options

Every tuning number is an option with its default in the doc comment of the field: the keys of `BuyerSettings` and `BuyRuleSettings`, `PoScoringThresholds`, `ForecastParams`, `BacktestOptions`, and the `aged_days` and `markdown_depths` options of the markdown function. `classSeasonalIndices` and `rollingBacktest` each take `ForecastParams`; pass the same values to both.

`BacktestOptions.velocity_split_units_per_month` (default 8) is the fast/slow line, in mean units a month over the last year. The backtest result records the split it used and `runLiveForecast` reads it from there, so a SKU is banded into the cell that was scored for it.

## Realised lead time

`realisedLeadTimes(lines, receipts, { asOf })` returns a map keyed by the order line's `supplier_ref`, each entry `{ median_days, p90_days, receipt_count }`.

- A receipt with a `line_ref` matches its order line on `po_ref` + `line_ref`. Lines no such receipt matches are grouped on `po_ref` + `sku` from their earliest order date, and match receipts without a `line_ref`.
- A line's lead time is the UTC calendar days from the order to the first receipt with a positive quantity. It counts from 1 day to `lead_time_max_days` (default 180). A same-day receipt means the order was raised at receipt, so it is unknown, not zero; a negative or longer figure is a data error. Both are dropped.
- Only lines ordered in the `lead_time_window_months` (default 12) before `asOf` count.
- The median and 90th percentile are nearest rank. Below `lead_time_min_receipts` (default 20) counted lines, a supplier gets its count and null for both figures, never an estimate.
- `po_ref` is compared as given: making the order and receipt sides agree (leading zeros, for example) is the caller's job. A line with no `supplier_ref` is not counted.

## Things to know

- The buy quantity carries no safety stock for demand variability.
- The buy quantity subtracts all incoming units due inside the next two months, whatever their arrival date within that window.
- The backtest keeps the first method in the list unless a later one beats it by more than `winner_epsilon_pts`, so the result depends on the order of the methods.

## Not in this package yet

- **Receipt dates in purchase-order scoring.** `realized_lead_time_days` on a scored purchase order is the days from `ordered_date` to `latest_eta` once anything has been received, and the scorecard's `lead_time_p50_days` and `lead_time_p90_days` take every positive value with no window or cap. `realisedLeadTimes` is the receipt-based figure.
- **A measured lead time in the buy quantity.** `resolveLeadTime` uses a brand override, then a class override, then the default. A measured supplier lead time does not reach `deriveSkuMetrics` (tracked separately).

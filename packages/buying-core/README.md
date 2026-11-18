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

- **Exclusions.** The caller drops excluded rows before calling; the package applies no exclusions.
- **Purchase-order rows.** `PurchaseOrderRow` is one row per purchase order. The caller rolls order lines up to one row per order; the roll-up rule is not set by this package and is tracked separately.

## What the caller supplies

Nothing below has a built-in value. Left out, the feature does nothing.

- **Brand.** The row's `brand` attribute. The package never reads a brand out of a SKU id. A row with no brand matches no brand override and no brand budget, and falls through to the class override, then the default.
- **Labels.** A row may carry a `label`. `label_roles` maps the caller's own label values to one of two roles: `priority` (a stocked-out row sorts first in the buy plan) and `run_down` (no EOQ top-up). With no labels or no map, nothing is prioritised or blocked.
- **EOQ costs.** `handling_cost_per_line` and `eoq_fallback_unit_cost` are in the caller's currency. Without a handling cost there is no EOQ top-up; without a fallback cost an unpriced SKU gets none.
- **Seasonal classes and the profitability curve.** `seasonal_classes` and `profitability_coverage_adjust` start empty.
- **Active rows.** `is_active` on a buy-plan or markdown row; a row that does not say is treated as active.

## Options

Every tuning number is an option with its default in the doc comment of the field: the keys of `BuyerSettings` and `BuyRuleSettings`, `PoScoringThresholds`, `ForecastParams`, `BacktestOptions`, and the `aged_days` and `markdown_depths` options of the markdown function. `classSeasonalIndices` and `rollingBacktest` each take `ForecastParams`; pass the same values to both.

## Things to know

- The buy quantity carries no safety stock for demand variability.
- The buy quantity subtracts all incoming units due inside the next two months, whatever their arrival date within that window.
- The backtest keeps the first method in the list unless a later one beats it by more than `winner_epsilon_pts`, so the result depends on the order of the methods.

## Not in this package yet

- **Realised lead time from receipts.** `realized_lead_time_days` is the days from `ordered_date` to `latest_eta` once anything has been received. It is the latest expected date, not a receipt date, so on a partly received order it reflects the units still due (tracked separately).
- **A window and a cap on supplier lead times.** `lead_time_p50_days` and `lead_time_p90_days` take every positive value. They do not limit lines to a recent window or drop values over a cap (tracked separately).
- **A measured lead time in the buy quantity.** `resolveLeadTime` uses a brand override, then a class override, then the default. A measured supplier lead time does not reach `deriveSkuMetrics` (tracked separately).

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

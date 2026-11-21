# @sprigr/apps-reporting-core

Pure reporting core. No IO, no clock, no tenant names. It turns a saved view into one DuckDB statement, which runs through the platform's `analytics_query` route or in DuckDB in the browser.

| Module | What it does |
|---|---|
| `model` | `validateModel(json)`: a tenant's dimensions, measures, streams and calendar, checked. `measureAvailability(model, schema)`: which measures a role can use, given the columns its build holds. |
| `formula` | `parseFormula`, `emitFormulaSql`: formula measures over other measures. Closed function list, typed, every division guarded. |
| `periods` | `resolvePeriod`, `splitWindow`, `comparisonWindow`, `monthsRange`: presets, custom and named periods, period columns. |
| `compile` | `compileView(model, view, { today })`: the statement, the column map, and the `months` range. |

```ts
const checked = validateModel(json);
if (!checked.ok) return checked.problems;
const out = compileView(checked.model, view, { today: '2026-11-21' });
if (!out.ok) return out.reason; // a closed set, see REPORTING_REASONS
run(out.sql, { months: out.months });
```

## Rules

- The compiler never decides who may see a column or a row. It runs against the tables the caller's role holds.
- Tables and columns come from the model and must be plain names. Values a person types (selections, keyword) are emitted as escaped string literals.
- A dimension's lookup table must hold one row per code, or sums multiply.
- "Today" is passed in, in the tenant's time zone.

## Compiled so far

Modes `total` and `period`; drill path; properties; dimension filters; keyword; sort; paging; total row; the SQL size check.

Refused with a named reason until built: modes variance, stream, transaction and matrix; filters on a measure; others and average rows; the activity option; snapshot measures; the grid functions RANK, PERCENTILE and FORECAST.LINEAR; a long (one row per period) shape for views too wide for the route's SQL limit.

## To check against the source system at migration

- "Last 3 months" is taken as the three whole months before this one, and "rolling 3" and "rolling 12" as ending with the current month.
- Month presets run to the end of the current month; `period_to_date` stops them at today.
- `-2^2` is -4.
- `AVERAGE` and `SUM` skip blanks.

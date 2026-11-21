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

Modes `total`, `period`, `variance`, `transaction`, `stream` and `matrix`; drill path; properties; dimension filters; filters on a measure; keyword; the activity option; snapshot measures; sort; paging; total row; the SQL size check.

- **Variance** reads the period and a comparison window (`compare`: the same dates a year earlier, or the period just before) in one pass. Each measure gets four columns: current, previous, variance and variance percentage (a fraction).
- **A filter on a measure** drops rows after grouping. It never drops the total row, which stays the total of every member. A measure the view does not show can be filtered on. Dimension rules and measure rules combine with "and" only.
- **Transaction** lists the fact rows: the date as text, every dimension code of the stream, the stream's extra `columns`, and each measure as that row holds it (a count is 1).
- **Stream** puts measures from more than one stream side by side over the whole period, such as invoiced beside ordered. It reads the view's own stream and every other stream its measures belong to. Each stream is grouped on its own under the same drill path, filters and keyword, then the results are folded to one row per member, so a formula can read sums from two streams. A member is listed when any of those streams has rows for it. Every stream read must carry each dimension the view uses. `streams` in the result lists them.
- **Matrix** groups by two dimensions: `group_by` gives the rows and `across` the columns. The result is long, one row per cell, and the grid pivots it. `__row` and `__col` say where a cell goes (0 is a total), `__total = 1` marks a column total and `__across_total = 1` a row total. Cells, row totals, column totals and the grand total come from one pass, each worked out from its own sums. Rows are sorted, paged and filtered on a measure by their row totals. `across.limit` keeps the first columns (12 unless given), picked by the first measure's column total or by code. Row totals are always returned; column totals with `options.total_row`. A page holds fewer rows than in other modes, since each row costs one result row per column kept.
- **Activity** (`options.activity`): `with` lists members that have fact rows. `all` adds the members that have none, read from the dimension's own table. `without` lists only those, with no total row. The keyword, and the path steps and "and" filters on the group-by dimension or a dimension above it, narrow the member list; every filter decides what counts as activity.
- **A snapshot measure** (a level, such as stock on hand) reads the rows of the latest day in each window. That day is the same for every member and is found before any filter, so the stream must hold every member's row on each snapshot day.

Refused with a named reason until built: others and average rows; the activity option, period columns and a variance in stream and matrix modes; a snapshot measure or a total row on a transaction list; the grid functions RANK, PERCENTILE and FORECAST.LINEAR; a long (one row per period) shape for views too wide for the route's SQL limit.

## To check against the source system at migration

- "Last 3 months" is taken as the three whole months before this one, and "rolling 3" and "rolling 12" as ending with the current month.
- Month presets run to the end of the current month; `period_to_date` stops them at today.
- `-2^2` is -4.
- `AVERAGE` and `SUM` skip blanks.
- In a variance, a blank counts as 0, and the percentage is blank when there is no previous value.
- With a filter on a measure, the total row is the total of every member, not of the rows left showing.

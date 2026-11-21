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

Modes `total`, `period`, `variance`, `transaction`, `stream` and `matrix`; drill path; properties; dimension filters; filters on a measure; keyword; the activity option; snapshot measures; sort; paging; total, others and average rows; an average column; hiding zero rows; the SQL size check.

`__total` says what a result row is: 0 a member, 1 the total, 2 the others row, 3 the average row.

- **Variance** reads the period and a comparison window (`compare`: the same dates a year earlier, or the period just before) in one pass. Each measure gets four columns: current, previous, variance and variance percentage (a fraction).
- **A filter on a measure** drops rows after grouping. It never drops the total row, which stays the total of every member. A measure the view does not show can be filtered on. Dimension rules and measure rules combine with "and" only.
- **Transaction** lists the fact rows: the date as text, every dimension code of the stream, the stream's extra `columns`, and each measure as that row holds it (a count is 1).
- **Stream** puts measures from more than one stream side by side over the whole period, such as invoiced beside ordered. It reads the view's own stream and every other stream its measures belong to. Each stream is grouped on its own under the same drill path, filters and keyword, then the results are folded to one row per member, so a formula can read sums from two streams. A member is listed when any of those streams has rows for it. Every stream read must carry each dimension the view uses. `streams` in the result lists them.
- **Matrix** groups by two dimensions: `group_by` gives the rows and `across` the columns. The result is long, one row per cell, and the grid pivots it. `__row` and `__col` say where a cell goes (0 is a total), `__total = 1` marks a column total and `__across_total = 1` a row total. Cells, row totals, column totals and the grand total come from one pass, each worked out from its own sums. Rows are sorted, paged and filtered on a measure by their row totals. `across.limit` keeps the first columns (12 unless given), picked by the first measure's column total or by code. Row totals are always returned; column totals with `options.total_row`. A page holds fewer rows than in other modes, since each row costs one result row per column kept; a `limit` above that is cut down, and `limit` in the result says what a page holds.
- **A period view that is too wide** for one column per period (the route takes 24,000 characters of SQL) is returned long instead: the matrix result with the periods as its columns, `shape: 'long'`, and `across` holding the period's number from the oldest. A period no row falls in has no cell. A total is worked out over the whole window, so `DAYS()` and a snapshot measure read the window there and the period on a cell. `sort.by` can still name one period of a shown measure. `periodShape` in the context forces `wide` or `long`; left out, the compiler goes long only when it must. A page holds fewer rows (153 with 12 periods), and `limit` in the result says how many.
- **Activity** (`options.activity`): `with` lists members that have fact rows. `all` adds the members that have none, read from the dimension's own table. `without` lists only those, with no total row. The keyword, and the path steps and "and" filters on the group-by dimension or a dimension above it, narrow the member list; every filter decides what counts as activity.
- **The others row** (`options.others_row`, modes `total`, `period` and `variance`): a view is focused when its drill path has a step on the group-by dimension itself. The others row is every member that step leaves out, as one row, with formulas worked out from its own sums. The total row is then the focused members' total. Without a focus there is no others row.
- **The average row** (`options.average_row`, same modes): the plain mean of each measure column over the member rows of the list, on every page, after any filter on a measure. Blanks are skipped.
- **The average column** (`options.average_column`, period mode with one column per period): one more column a measure, the mean of that measure's period columns on the same row, so the total row holds the mean of the period totals. A period with no value is skipped, not counted as zero. `sort.by` takes `average.<measure>`. Other modes ignore the option.
- **Hiding zero rows** (`options.hide_zero_rows`, every grouped mode): leaves out a member whose every shown measure is zero or blank over the whole period, and in a variance over the earlier period too. Sales that net to zero are hidden even when single periods are not zero. The total row still counts those members; the row count and the average row do not.
- **A snapshot measure** (a level, such as stock on hand) reads the rows of the latest day in each window. That day is the same for every member and is found before any filter, so the stream must hold every member's row on each snapshot day.

Refused with a named reason until built: others and average rows in stream and matrix modes and in the long shape of a period view; an others row or hidden zero rows with the activity option; the average column in the long shape of a period view; the activity option, period columns and a variance in stream and matrix modes; the activity option in the long shape of a period view; a snapshot measure or a total row on a transaction list; the grid functions RANK, PERCENTILE and FORECAST.LINEAR.

## To check against the source system at migration

- "Last 3 months" is taken as the three whole months before this one, and "rolling 3" and "rolling 12" as ending with the current month.
- Month presets run to the end of the current month; `period_to_date` stops them at today.
- `-2^2` is -4.
- `AVERAGE` and `SUM` skip blanks.
- In a variance, a blank counts as 0, and the percentage is blank when there is no previous value.
- With a filter on a measure, the total row is the total of every member, not of the rows left showing.
- The average row is the mean of the rows' own values, so for a ratio it is the mean of the row ratios, and it covers every page of the list.
- The others row covers the members a focus leaves out that still pass the view's other filters and keyword.
- The average column skips a period with no value. If the source divides by the number of periods instead, the two differ for a member with empty periods.
- A row is hidden as zero when its figures over the whole period are zero, whatever its single periods hold.

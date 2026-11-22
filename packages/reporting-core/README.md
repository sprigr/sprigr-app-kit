# @sprigr/apps-reporting-core

Pure reporting core. No IO, no clock, no tenant names. It turns a saved view into one DuckDB statement, which runs through the platform's `analytics_query` route or in DuckDB in the browser.

| Module | What it does |
|---|---|
| `model` | `validateModel(json)`: a tenant's dimensions, measures, streams and calendar, checked. `measureAvailability(model, schema)`: which measures a role can use, given the columns its build holds. |
| `formula` | `parseFormula`, `emitFormulaSql`: formula measures over other measures. Closed function list, typed, every division guarded. |
| `periods` | `resolvePeriod`, `splitWindow`, `comparisonWindow`, `monthsRange`: presets, custom and named periods, period columns. |
| `compile` | `compileView(model, view, { today })`: the statement, the typed values it reads (`params`), the column map, the `months` range and the `tables` it reads. `compileRollupView`: the same view over a monthly rollup, for the browser. |
| `grid` | `pivotLong(compiled, rows)`: the rows of a long result folded to one grid row per member with one cell per column. |

```ts
const checked = validateModel(json);
if (!checked.ok) return checked.problems;
const out = compileView(checked.model, view, { today: '2026-11-21' });
if (!out.ok) return out.reason; // a closed set, see REPORTING_REASONS
run(out.sql, { params: out.params, months: out.months });
```

## Rules

- The compiler never decides who may see a column or a row. It runs against the tables the caller's role holds.
- Tables and columns come from the model and must be plain names.
- A value a person types (a selection, the keyword) is never statement text. The statement holds a `?` for each and `params` holds the values as strings, in the order the statement reads them. Send both to an engine that binds values. `inlineParams(sql, params)` writes them in as escaped literals for an engine or route that takes none; the route then refuses a value that holds `--` or looks like a file or web location.
- The length check counts the statement with its values written in, so it fits either way it is sent.
- A table cannot be named `g`, `r`, `v`, `a`, `sm`, `rw`, `cl`, or `s` and a number, in any case. The compiler gives the stages of its statement those names, and DuckDB would read the stage in place of the table. `validateModel` refuses such a model.
- Every stage of the statement opens as `name AS (`, with nothing between. The route reads any other opening for a table and refuses the statement.
- A table or column cannot be named for a word the route refuses, such as `set`, `use`, `load`, `copy`, `update` or `delete`, in any case. The route refuses the word even inside a quoted name. `validateModel` refuses such a model with `reserved_name`.
- A dimension's lookup table must hold one row per code, or sums multiply.
- "Today" is passed in, in the tenant's time zone.

## Rollups

The fact table is too big to hand to a browser; a rollup of it by month is not. A stream lists its rollups in the model:

```json
{ "key": "by_branch", "table": "sales_month_branch", "date": "month",
  "dimension_keys": { "branch": "branch_code" },
  "measure_columns": { "sales": "amount", "lines": "line_count" } }
```

`date` holds the first day of each row's month. `dimension_keys` are the stream's dimensions the rollup keeps. `measure_columns` are the stream's base measures it carries, each already worked out for the row's month; a sum or a count is added up again and a least or greatest value taken again. A snapshot, a distinct count and an average cannot be rebuilt from months, and `validateModel` refuses a rollup that lists one.

`compileRollupView(model, view, ctx)` compiles the view over rollups in place of fact tables. The statement is the one `compileView` writes, with the table, the date column and the measure columns swapped, so both return the same rows. `rollups` in the result names the rollup read for each stream. It refuses `no_rollup`, and the caller then runs the view through the route, when:

- a stream the view reads has no rollup holding every dimension and measure the view needs (a dimension reached through a parent needs the parent, and a formula needs every measure it reads);
- a window or period of the view does not start and end on the first of a month, such as a period to date, a week or a custom range of days;
- the view is a transaction list or reads a snapshot measure.

Of the rollups that can answer, the one with the fewest dimensions is read, then the first listed. A view that does not compile at all refuses with its own reason. The statement still joins the dimension tables for names, properties and parent dimensions, so the caller loads those beside the rollup. `tables` in the result lists every table the statement reads, rollups and dimension tables alike, in the order it first reads them.

## The grid of a long result

A matrix view, and a period view too wide for one column per period, come back long: one result row per cell (`shape: 'long'`). `pivotLong(compiled, rows)` folds them:

```ts
const grid = pivotLong(out, rows);
grid.columns; // [{ number, across, label, period? }], in display order
grid.rows;    // [{ code, total, number, properties, cells, totals }], the total row first
```

`cells` has one entry per column, holding the measures by result column name (`m__sales`), or null where no fact row falls. `totals` is the row's own total over every column. `rowCount` and `columnCount` are the sizes before paging and before the cut to the columns kept. Whole numbers may arrive as bigints, as DuckDB in the browser returns them.

A period view lists every period as a column; `reversed` in the compiled result says the newest comes first. A matrix lists the columns kept, read from the column totals that every page of its result carries, so the columns are the same on every page. The total row is in the grid only when the view asked for it.

## Compiled so far

Modes `total`, `period`, `variance`, `period_variance`, `transaction`, `stream`, `matrix` and `custom`; drill path; properties; dimension filters; filters on a measure; keyword; the activity option; snapshot measures; sort; paging; total, others, average and sum rows; an average column; hiding zero rows; the SQL size check.

`__total` says what a result row is: 0 a member, 1 the total, 2 the others row, 3 the average row, 4 the sum row.

- **Variance** reads the period and a comparison window (`compare`: `previous_year` for the same dates a year earlier, `previous_period` for the period just before, or `{ period }` for a window of its own, which may overlap the period or come after it) in one pass. Each measure gets four columns: current, previous, variance and variance percentage (a fraction).
- **Period variance** is a period view where every period is a variance. Each period gets four columns: its own value, the value of the period at the same place in the comparison window, the variance and the variance percentage. The same four over the whole windows follow. `compare` is read as in a variance. The comparison window is cut with the period's grain, and the view is refused when the two windows do not cut into the same number of periods. Columns are named `b<n>__`, `pb<n>__`, `bv<n>__` and `bvp<n>__` before the measure key, `<n>` counted from the oldest period; each carries `bucket: n` and its `part`. `sort.by` and a filter on a measure take what a period view and a variance take. The statement is always one column per period, and a view too wide for the route is refused.
- **A filter on a dimension** tests fact rows, on the code or on a property. `in` and `not_in` match whole values. `contains` and `not_contains` look for text anywhere in the value, whatever its case; a rule with several texts passes when any one is found, and a text can be up to 200 characters. A row with no value passes `not_in` and `not_contains`. Rules sit in groups joined by `and` or `or`, up to three deep, so a search over a code or a name is an `or` group of two `contains` rules. A data point of a custom view takes the same rules.
- **A filter on a member's own figure** names a dimension and a measure together: `{ dimension, measure, cmp, value, period? }`. It keeps the fact rows of the members whose figure passes, worked out over the rule's own `period` (the view's when it gives none), so "products that sold more than 100 last year" can filter a view of this month. It sits with the dimension rules, in `and` and `or` groups and in every mode. The figure is over all of the stream's rows in those dates, whatever else the view filters on, and the measure must be the view's stream's own, so a view that reads several streams refuses. The result lists the dates each such rule reads in `ruleWindows`, and `months` covers them. A data point of a custom view does not take one.
- **A filter on a measure** drops rows after grouping. It never drops the total row, which stays the total of every member. A measure the view does not show can be filtered on. Dimension rules and measure rules combine with "and" only.
- **Transaction** lists the fact rows: the date as text, every dimension code of the stream, the stream's extra `columns`, and each measure as that row holds it (a count is 1).
- **Stream** puts measures from more than one stream side by side over the whole period, such as invoiced beside ordered. It reads the view's own stream and every other stream its measures belong to. Each stream is grouped on its own under the same drill path, filters and keyword, then the results are folded to one row per member, so a formula can read sums from two streams. A member is listed when any of those streams has rows for it. Every stream read must carry each dimension the view uses. `streams` in the result lists them.
- **Matrix** groups by two dimensions: `group_by` gives the rows and `across` the columns. The result is long, one row per cell, and the grid pivots it. `__row` and `__col` say where a cell goes (0 is a total), `__total = 1` marks a column total and `__across_total = 1` a row total. Cells, row totals, column totals and the grand total come from one pass, each worked out from its own sums. Rows are sorted, paged and filtered on a measure by their row totals. `across.limit` keeps the first columns (12 unless given), picked by the first measure's column total or by code. Row totals and column totals are always returned, the column totals because they name the columns; the grand total comes with `options.total_row`. A page holds fewer rows than in other modes, since each row costs one result row per column kept and the column totals take one each; a `limit` above that is cut down, and `limit` in the result says what a page holds.
- **Custom** builds each column on its own. `custom_columns` lists them and `measures` is not read. A column is one of three things. A data point: `point` names a measure, and may give its own `period` (the view's period when left out) and a `where` rule on one dimension, such as sales of one department last June. A comparison: `point` and `against`, shown as the difference or, with `show: 'percent'`, as a fraction of the second point; a blank counts as 0 and the percentage is blank when there is nothing to compare against, as in a variance. An expression: a formula over the column's own `points`, named by the letters the formula uses, with a `format` (`number` unless given). `hidden` keeps a column out of the result; it can still be sorted on. `sort.by` takes `code`, `property.<key>` or `column.<key>`, and the first shown column, descending, when left out. Every distinct data point is read once, in one pass over the rows of every window the columns use. Result columns are named `c__<key>`. `windows` in the result lists those windows and `window` runs from the earliest to the latest. The drill path, dimension filters, keyword, properties, the total, sum and average rows and hiding zero rows work as in total mode, the last three over the shown columns. A snapshot measure reads the latest day of its own point's window.
- **A period view that is too wide** for one column per period (the route takes 24,000 characters of SQL) is returned long instead: the matrix result with the periods as its columns, `shape: 'long'`, and `across` holding the period's number from the oldest. A period no row falls in has no cell. A total is worked out over the whole window, so `DAYS()` and a snapshot measure read the window there and the period on a cell. `sort.by` can still name one period of a shown measure. `periodShape` in the context forces `wide` or `long`; left out, the compiler goes long only when it must. A page holds fewer rows (153 with 12 periods), and `limit` in the result says how many.
- **Activity** (`options.activity`): `with` lists members that have fact rows. `all` adds the members that have none, read from the dimension's own table. `without` lists only those, with no total row. The keyword, and the path steps and "and" filters on the group-by dimension or a dimension above it, narrow the member list; every filter decides what counts as activity.
- **The others row** (`options.others_row`, modes `total`, `period` and `variance`): a view is focused when its drill path has a step on the group-by dimension itself. The others row is every member that step leaves out, as one row, with formulas worked out from its own sums. The total row is then the focused members' total. Without a focus there is no others row.
- **The sum row** (`options.sum_row`, modes `total`, `period`, `variance` and `stream`): each measure column added up over the member rows of the list, on every page, after any filter on a measure. It differs from the total row on a ratio, where it is the sum of the rows' ratios and the total row is the ratio of the sums.
- **The average row** (`options.average_row`, same modes as the sum row): the plain mean of each measure column over the member rows of the list, on every page, after any filter on a measure. Blanks are skipped.
- **The average column** (`options.average_column`, period mode with one column per period): one more column a measure, the mean of that measure's period columns on the same row, so the total row holds the mean of the period totals. A period with no value is skipped, not counted as zero. `sort.by` takes `average.<measure>`. Other modes ignore the option.
- **Hiding zero rows** (`options.hide_zero_rows`, every grouped mode): leaves out a member whose every shown measure is zero or blank over the whole period, and in a variance over the earlier period too. Sales that net to zero are hidden even when single periods are not zero. The total row still counts those members; the row count and the average row do not.
- **Nested rows** (`levels`, modes `total`, `period` with one column per period, `variance`, `period_variance` and `custom`): up to five dimensions above `group_by`, the outermost first, such as branch, then department, then product as the rows. Each member of a level gets a row of its own, the subtotal of the rows beneath it, with formulas worked out from its own sums. Every level is grouped in the same pass as the rows, so it is still one statement. A row comes right after the row it sits under. Each level is ordered by its own figure in the column the view is sorted on, or by its code when the sort is on the code or a property. The result has `lv<n>` for each level's code and `lvn<n>` for its name where the dimension has one (`kind: 'level'`, with `level` and `dimension`), and `__level`: 1 on the outermost level's rows, one more on each level below, and 0 on the total row. `code` and the properties are blank on a level's row. `limit`, `offset` and `__rows` count every row, level rows included, so a page can start part way down a level. The total row works as in total mode. Not compiled with nested rows yet: the activity option, the others, average and sum rows, hiding zero rows, a filter on a measure, stream and matrix modes, and the long shape of a period view. Opening one row of a nested grid needs no nested statement: it is a plain view grouped by the next dimension with a path step on the row opened. The nested statement is for showing every level at once, as an export or an emailed report does.
- **A snapshot measure** (a level, such as stock on hand) reads the rows of the latest day in each window. That day is the same for every member and is found before any filter, so the stream must hold every member's row on each snapshot day.
- **A measure of two columns** (`times` on a base measure that is not a count): reads `column` times the `times` column on each row, then aggregates, such as units on order times a unit cost. A rollup's column for such a measure already holds the product, so the rollup is read as it is. `measureAvailability` hides the measure from a role that lacks either column.

Refused with a named reason until built: an others row in stream mode; others, average and sum rows in matrix mode and in the long shape of a period view; an others row or hidden zero rows with the activity option; the average column in the long shape of a period view; the activity option, period columns and a variance in stream and matrix modes; the activity option in the long shape of a period view; a snapshot measure or a total row on a transaction list; a filter on a measure, an others row and the activity option in custom mode; the grid functions RANK, PERCENTILE and FORECAST.LINEAR.

## To check against the source system at migration

- "Last 3 months" is taken as the three whole months before this one, and "rolling 3" and "rolling 12" as ending with the current month.
- Month presets run to the end of the current month; `period_to_date` stops them at today.
- `-2^2` is -4.
- `AVERAGE` and `SUM` skip blanks.
- In a variance, a blank counts as 0, and the percentage is blank when there is no previous value.
- With a filter on a measure, the total row is the total of every member, not of the rows left showing.
- The average row is the mean of the rows' own values, so for a ratio it is the mean of the row ratios, and it covers every page of the list.
- The sum row adds up every measure column as it stands, ratios and percentages included.
- The others row covers the members a focus leaves out that still pass the view's other filters and keyword.
- The average column skips a period with no value. If the source divides by the number of periods instead, the two differ for a member with empty periods.
- A row is hidden as zero when its figures over the whole period are zero, whatever its single periods hold.
- Period variance pairs the periods of the two windows by their place: the first with the first, and so on.
- A custom view lists a member when it has rows in any window its columns read, and the total row of a column with its own rule is the total of the rows that rule keeps.
- In a custom view `DAYS()` in an expression column is the days of the view's own period; inside a measure it is the days of that data point's window.
- In a nested view a level's row is the subtotal of everything beneath it, not of the rows on the page, and a ratio on it is the ratio of its own sums.

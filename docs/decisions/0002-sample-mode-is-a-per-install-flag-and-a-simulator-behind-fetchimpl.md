# 0002: Sample mode is a per-install flag, with a simulator behind `fetchImpl`

Status: proposed (sprigr-team#15268, step 2c)

## Context

Guided setup can put a workspace in sample mode (sprigr-team decision 0419). The platform stores it as a company setting, fires `on_sample_load` on every install when it turns on, and to end it fires `on_sample_remove` on every install, clearing the setting only when every install answers ok. While it is on, an app must answer its tools from sample data and never reach the vendor.

The app cannot learn sample mode from the request. Install dispatch reads no company settings, and the caches in front of it (the app runner's 30 s target memo, the schedule roster's up to 30 min) would serve a flipped value late. So the app keeps its own record, written by the two hooks the platform already fires.

## Decision

`@sprigr/apps-vendor-simulator` keeps that record and answers from it.

- **A flag row per install.** It sits in the app's own per-install D1, in the same table as the overlay, under a reserved resource. `on_sample_load` writes it and keeps any overlay rows. `on_sample_remove` deletes the flag and the overlay in one statement.
- **Three states.** Row present: on, the simulator answers. No row: off, the network answers. Failed read: unknown, refused with `SampleModeUnknownError` (`sample_mode_unknown`); neither the network nor the simulator is called. Each state has a red-first test.
- **Read at most once per invocation.** The switch keeps its first answer, a failed read included, for its own life, and the app builds one switch per invocation. That adds one D1 read per invocation that makes a vendor call, on every install of an adopting app, in sample mode or not. In sample mode a simulated request adds one overlay read, and each written object one D1 write. An adopting app's call-budget entry changes in that app's own PR.
- **A failed hook never answers ok.** A failed delete in `on_sample_remove` rejects, so the platform does not see ok and keeps sample mode on under its existing every-install rule. A failed write in `on_sample_load` rejects too. Each has a test.
- **Seed plus overlay.** The seed ships read-only in the app bundle. Writes land in the overlay, per install. A dialect declares the vendor's routes as data. The first dialect is a plain request dialect, and no source file names an app (a test scans for it).
- **Unrouted means not sent.** In sample mode, a request the dialect has no route for throws `NotSimulatedError` (`not_simulated`, with method and path) and is never sent.

## Where the switch is wired

`sampleAwareFetch` returns a `FetchImpl`. Each adopting app builds it per invocation and passes it as `fetchImpl` to `fetchWithBudget`, or to its own vendor client. `@sprigr/apps-fetch-budget` does not call it and does not change. It has no D1 handle, seed or table name, and reading the flag there would add a D1 read to every app that uses it, adopters or not.

**What stops a path that forgets it: nothing in this package.** A vendor call made with the global `fetch`, or through `fetchWithBudget` without this `fetchImpl`, reaches the network with the flag on. Until the platform egress fence (step 2b) is decided, the guard is per app. An adopting app routes every vendor call through one client function that takes the `fetchImpl`. Its adoption PR carries a test that runs every declared tool and action with the flag on and asserts the network stub is never called, and a write with the flag unreadable that answers not sent. That test belongs to each app's proof, not to this package.

## Ending sample mode

The only way to end it is through `on_sample_remove`. The planned rule that connecting a real system ends sample mode inherits this: it must end it through the same hook, not by clearing the setting directly. An app installed while sample mode is already on never receives `on_sample_load` (sprigr-team#16256). This package does not solve that.

## Alternatives rejected

- **A header from the platform dispatch (step 2a).** Dispatch reads no company settings, and the cached targets above would carry a stale value for up to 30 min.
- **Reading the flag on every fetch.** One D1 read per vendor call instead of per invocation, for no gain within one invocation.
- **Treating unknown as on or off.** As off, a sample workspace's request could reach the vendor. As on, a real workspace could be shown sample data as if it were real. Refusing is the only safe answer.
- **Wiring it inside fetch-budget.** See above.

## Open wording

The messages of `NotSimulatedError` and `SampleModeUnknownError` are not final. The owner sets the text.

## Consequences

- Each adopting app adds one migration (the table), the two hooks, a seed, a dialect, and one `fetchImpl` at its vendor client.
- Ending sample mode deletes every write a person made while sampling. That is the point of sample data.
- Until step 2b, an app path that bypasses its vendor client is caught only by that app's tests.
- `SampleModeUnknownError` and `NotSimulatedError` both mean nothing was sent. An adopting app maps them to its not-sent answer, never to an unknown outcome such as `write_may_have_applied`. Its adoption tests include a write with the flag unreadable that answers not sent.
- A create carrying an id that already exists replaces that object. A real vendor would usually refuse it.
- An invocation that read on just before `on_sample_remove` can still write an overlay row after the clear. `on_sample_load` keeps overlay rows, so that row shows up in the next sample session.

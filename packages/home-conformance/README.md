# @sprigr/apps-home-conformance

The executable half of the Sprigr Home contracts for an app's Home tool (FINAL-APP-FEEDS section 12). It drives the tool the way the platform dispatches it, through `@sprigr/apps-home/testing`'s `fakeHome`, and checks the promises a type checker cannot see: who the tool answers for, that it changes nothing, and that it answers small and fast enough.

```ts
import { describeHomeConformance } from '@sprigr/apps-home-conformance/vitest';
import { get_my_app_home } from '../src/handlers/home';
import manifest from '../sprigr-app.json';
import { fakeEnv } from './__helpers__/fake-env';

// fakeEnv connects usr_conformance_a and usr_conformance_b to vendor accounts
// of their own, each with records, and binds D1 and env.SPRIGR as the app does.
describeHomeConformance('my-app', { manifest, tool: get_my_app_home, env: fakeEnv });
```

Or, without vitest: `const report = await runHomeConformance({ manifest, tool, env })`, then `formatReport(report)`.

## What it checks

For every provider in the manifest's `home` block, and its identity provider:

| Check | The rule |
|---|---|
| `<id>.envelope_and_basis` | The answer passes the platform's answer check and echoes the request's `basis`, for two requests either side of local midnight in Australia/Brisbane. A 23:30 request is still that day; the next day's window starts at 14:00Z, so an app that reads the UTC date answers for the wrong day. |
| `<id>.refuses_no_actor`, `<id>.refuses_agent_only_actor` | A `per_user` provider (and the identity provider) refuses a call with no actor, and one whose actor is an agent with no person, as `no_caller_identity`. It never answers from someone else's connection. |
| `<id>.answers_without_actor` | A `company` provider answers with no actor. |
| `<id>.actor_isolation` | Two people never see each other's records. |
| `<id>.body_under_64kb` | Every answer is under 64 KB. |
| `<id>.under_budget_or_rate_limited` | Every answer arrives inside the budget (default 2 s), or is `rate_limited`. |

Across the run:

| Check | The rule |
|---|---|
| `manifest.home_block` | The `home` block is one the platform accepts at publish. The run stops here if not. |
| `env.no_d1_writes` | No D1 binding in the env runs a write (INSERT, UPDATE, DELETE, REPLACE, UPSERT, CREATE, DROP, ALTER), through `prepare`, `batch` or `exec`. The binding is wrapped, not faked, so the app runs as it would. |
| `env.sprigr_reads_only` | `env.SPRIGR` is called only for the reads a Home dispatch allows (sprigr-team decision 0177, `HOME_DISPATCH_READ_METHODS`). Anything else is refused with `home_read_only`, as on the platform, and reported. |

A check is never skipped. A rule the harness could not exercise fails and says what to supply. The usual one is `actor_isolation` when one of the two people has no records: build an env where both are connected to vendor accounts of their own, each with records.

## Options

- `manifest`: the parsed `sprigr-app.json`.
- `tool`: the Home tool, built with `homeTool` or hand-written (one that returns the answer itself is read the way the platform reads it).
- `env()`: called **once**; the same env reaches every call.
- `actors`: the two people for the isolation check (default `usr_conformance_a`, `usr_conformance_b`).
- `people`: the vendor person id put on a request that needs one, by `platformUserId` (default `person_a`, `person_b`).
- `timeBudgetMs`: default 2000. A call that never settles is cut off at five times the budget (at least the budget plus 2 s) and reported, rather than hanging the suite.
- `day`: the viewer's local day (default 2026-10-07).

`trackD1(db)`, `readOnlySprigr(sprigr)` and `HOME_DISPATCH_READ_METHODS` are exported for an app that wants the same checks in its own tests.

Peer dependencies: `@sprigr/apps-home` `>=0.2.0 <1` (for `fakeHome`), and `vitest` for the `/vitest` entry point only.

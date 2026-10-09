# Sprigr Home contracts, version 1 (contract)

How a marketplace app feeds the Sprigr Home: the five platform-owned contracts, the request an app's Home tool receives, the answer it returns, the manifest `home` block, and the rules the platform enforces. This is the normative reference. The guide is [`docs/home-contracts.md`](../home-contracts.md).

**The code is the authority.** Every rule here is implemented in `@sprigr/apps-home` (`packages/home`), whose contract files are verbatim copies of the platform's own (sprigr-team `packages/shared/src/home-contracts/`): `validateHome` for the manifest, `homeRequestProblems` for the request, `checkHomeAnswer` for the answer, `validateHomeFixtures` for fixtures. Where this page and that code ever disagree, the code wins and this page is the bug. The platform decisions behind it are sprigr-team 0170 to 0178.

## 1. Roles

- **The platform** decides what is shown, in what order, in what words, and to whom. It builds every request, stamps the actor, caches answers, and merges several apps onto one Home.
- **The app** sends data up: its own ids, UTC instants, integer minor-unit money, and values from closed vocabularies. It never sends a colour, a rank, a layout or a connective sentence. Alerts are queue records with `reason: 'broken'`, not a separate contract.

An app has **one** Home tool. It is read-only, and it routes on the provider id.

## 2. The five contracts

| Contract | Answers | Records per answer |
|---|---|---|
| `sprigr/home_schedule` | Time on the day: jobs, meetings, deliveries | at most 200 |
| `sprigr/home_queue` | Things that need someone, with a reason | at most 50 |
| `sprigr/home_metrics` | Numbers: money owed, orders to ship | at most 12 |
| `sprigr/home_subject_facts` | Facts about a customer or job, joined across apps | 500 in `bulk` mode, 20 in `ref` mode |
| `sprigr/home_identity` | Who the viewer is in the vendor | exactly 1 |

Each is at version `1.0.0`. `home_identity` is declared once in `home.identity`; the other four are providers in `home.provides`.

## 3. The request

The platform builds the request from its own values and the manifest's static fields. On a Home dispatch to the app's Home tool, the platform's wrapper puts it in `args._home`, and puts the body's `{ provider }` beside it. It also sets `args.actor` for a person's provider (section 7). Any caller's copy of `_home` is stripped on every other path, so **an app reads `args._home` and trusts nothing else** (decision 0177).

| Field | Meaning |
|---|---|
| `contract` | One of the five contract ids. |
| `version` | The highest version the platform renders, e.g. `1.0.0`. |
| `provider` | The manifest's `provides[].id`, or the identity provider id. |
| `scope` | `me`, `crew` or `company`: whose data the provider answers about. |
| `basis` | `{ day, tz, window_start, window_end }`: the viewer's local day (`YYYY-MM-DD`), their IANA zone, and that day's local midnight to the next local midnight as UTC `Z` instants. Daylight saving makes a 23- or 25-hour day. |
| `person` | `{ vendor_person_id, method }`, when the viewer is linked to a person in the vendor. `method` is `native`, `email_match`, `single_person` or `picked`. |
| `mode` | `sprigr/home_subject_facts` and `detail` requests only: `{ kind: 'bulk' }`, or `{ kind: 'ref', ref }`, where `ref` is one of this app's ids. |
| `purpose` | `read`, `precompute`, `detail`, `identity` or `preview`. |
| `deadline_ms` | `3500`. The platform cuts the dispatch at 4000 ms. |

## 4. The answer

The tool returns the answer, or `{ ok: true, result: answer }`. The platform unwraps one nested `{ ok, result }`, and reads `{ ok: false, error }` as an app error.

| Field | Rule |
|---|---|
| `v` | The version actually used; at most `request.version`. |
| `state` | `ok`, `empty`, `not_connected`, `colleague_only`, `unmapped`, `rate_limited` or `error`. |
| `as_of` | When the data was true at the vendor, a UTC `Z` instant. Clamped to the platform's clock on receipt. |
| `stale_after` | Optional. May only shorten the provider's declared TTL. |
| `next_refresh_at` | Optional. A timeline hint, such as the next booking's start. |
| `basis` | `{ day, tz }`, echoed from the request. A mismatch is refused as `error`. |
| `records` | Empty unless `state` is `ok`. At most the contract's cap. |
| `truncated` | `{ at_least }` when there were more records than the cap. |
| `retry_after_s` | `rate_limited` only. |

**States the platform draws differently:**
- `empty` is the truth ("nothing today"), not a failure.
- `not_connected`: the viewer has not connected their own account.
- `unmapped`: the viewer is not linked to a vendor person, so a person's provider cannot answer.
- `colleague_only`: only a colleague's connection could answer. The platform never borrows it.
- `rate_limited`: the vendor, or the app's own budget, says wait.

**Answer-level versus record-level problems.** An answer-level problem (a bad envelope, a basis mismatch, a cap overrun) makes the platform treat the whole answer as `error`. A record-level problem drops that record alone: it is never drawn and never cached.

## 5. Records

Shared value rules:
- Instants are UTC with `Z` (fractions of a second up to six digits); local days are `YYYY-MM-DD`.
- Money is `{ minor, currency }`: integer minor units and an ISO 4217 code.
- `ref` is `{ id, label?, link? }`. `id` is the app's own stable id (at most 128 characters), `label` the human number (at most 32), and `link` a `home.links[].id`.
- `subjects` are join keys, never shown: at most 4, each `{ key, value, issuer? }`. `key` is `email`, `order_ref`, `customer_ref`, `abn`, `invoice_ref` or `job_ref`. A `*_ref` is exact and carries the `issuer` (the app slug that minted it). An `abn` is exactly 11 digits that pass the ABN checksum; spaces are refused, not normalised.
- `detail` is at most 4 fields, each `{ label, value, type }`: `label` at most 24 characters, `type` one of `string`, `number`, `date`, `money`.
- **Display text** (titles, locations, labels, notes) is plain: no markup, no URL, no emoji, no `!`. A record whose display text the platform's sanitizer would change is dropped. `homeDisplayText(text, max)` cleans vendor text to these rules.

### 5.1 `sprigr/home_schedule`

| Field | Rule |
|---|---|
| `id` | Required, stable across refreshes. |
| `kind` | `block`, `window` ("arrive 8 to 12"), `deadline` or `all_day`. |
| `start` | Required unless `all_day`. |
| `end` | Required for `block` and `window`. |
| `day` | Required for `all_day`. |
| `person` | The `vendor_person_id`; required when the request's scope is `crew`. |
| `status` | `tentative`, `scheduled`, `en_route`, `started`, `done` or `cancelled`. |
| `category` | `job`, `meeting`, `task`, `delivery`, `inspection` or `other`. |
| `title` | Required, at most 80 characters. |
| `location` | `{ text }`, at most 160 characters. |
| `subjects`, `ref`, `detail` | As above; `ref` is required. |
| `same_as` | `{ ical_uid }`, for exact de-duplication against calendar copies. |
| `vendor_tz` | When the vendor's zone differs from `basis.tz`. |

### 5.2 `sprigr/home_queue`

The app gives a reason, never a rank; the platform assigns the tier.

| Field | Rule |
|---|---|
| `id`, `title` (at most 80), `ref` | Required. |
| `reason` | `expires`, `customer_waiting`, `colleague_waiting`, `broken`, `assigned`, `due` or `fyi`. |
| `why` | `quote_expires`, `enquiry_new`, `ticket_unanswered`, `bill_awaiting_approval`, `order_unfulfilled`, `task_due`, `approval_requested`, `sync_broken`, `connection_expiring`, `exception`, `stock_out`, `sla_breach` or `delivery_failed`. |
| `severity` | `warn` or `critical`; `reason: 'broken'` only. |
| `expires_at` | Required when `reason` is `expires`. |
| `waiting_since`, `due_at` | For display and checks only. Ranking uses the platform's first-seen time. |
| `count` | A grouped row: "5 bills to approve". |
| `subjects` | As above. |

### 5.3 `sprigr/home_metrics`

| Field | Rule |
|---|---|
| `metric` | `receivables.overdue`, `receivables.outstanding`, `payables.to_approve`, `payables.due_7d`, `cash.bank_balance`, `sales.day`, `sales.mtd`, `orders.unfulfilled`, `jobs.completed_unpaid`, `jobs.completed_not_invoiced`, `quotes.to_send`, `tickets.open_mine`, `exceptions.open`, `stock.low` or `crew.on_job`. No metric enters this list without a renderer. |
| `value` | `{ kind: 'money', amount }` or `{ kind: 'count', n }`. |
| `period` | `{ kind: 'instant' }`, `{ kind: 'day', day }`, `{ kind: 'range', from, to }` or `{ kind: 'all_time' }`. |
| `count` | "2 invoices" beside a money value. |
| `at_least` | A floor: "at least 6 jobs". |
| `compare` | `{ basis, value }`, where `basis` is `same_weekday_last_week`, `yesterday` or `last_month`. |
| `series` | At most 30 points, for a sparkline. |
| `ref` | Optional. |

### 5.4 `sprigr/home_subject_facts`

| Field | Rule |
|---|---|
| `id`, `ref` | Required. |
| `subjects` | Required, 1 to 4. |
| `fact` | `overdue_invoice`, `open_invoice`, `open_quote`, `last_visit_note`, `open_ticket`, `recent_order`, `unpaid_job` or `credit_hold`. |
| `date`, `amount` | Optional. |
| `text` | At most 160 characters, `last_visit_note` only. |

### 5.5 `sprigr/home_identity`

One record: `{ connection, native_person?, people? }`.
- `connection` is `personal`, `install_login`, `not_connected` or `expired`.
- `native_person` is the vendor's own "who am I": `{ vendor_person_id, display_name }`.
- `people` is at most 500 `{ vendor_person_id, display_name, email?, active }`. `email` is used for matching, then dropped by the platform.

An identity read is a status read; it never mints anything.

## 6. The manifest `home` block

```json
"home": {
  "tool": "get_my_app_home",
  "links": [{ "id": "job", "page": "/jobs/{ref}", "opens_in": "My App" }],
  "link_hosts": ["go.example.com"],
  "identity": { "contract": "sprigr/home_identity", "version": "^1.0", "provider": "whoami", "methods": ["native", "email_match"] },
  "rate": { "group": "my_app", "max_dispatches_per_minute": 30 },
  "provides": [
    { "id": "my_day", "contract": "sprigr/home_schedule", "version": "^1.0", "scope": "me", "audience": "per_user",
      "roles": ["owner", "admin", "manager", "member"], "requires_person": true, "ttl_seconds": 900,
      "fixtures": "home/fixtures/my_day.json" }
  ]
}
```

`validateHome` refuses, among others:

- **The tool.** `tool` must be exactly `get_<app slug, dashes as underscores>_home`, declared in `tools[]`, and classify as a read for dispatch (declare it `internal: true`). One tool, never an array.
- **Providers.**
  - At most 8 `provides` entries, each with a unique id matching `^[a-z][a-z0-9_]{1,31}$` and distinct from the identity provider id.
  - `contract` is one of the four provider contracts (identity is declared once in `home.identity`).
  - `version` is a requirement like `^1.0` that the platform serves.
  - `scope: 'me'` and `requires_person: true` need `audience: 'per_user'`.
  - A `scope: 'crew'` provider's `roles` may only be `owner`, `admin` or `manager`.
  - `ttl_seconds` is an integer from 60 to 3600.
  - `fixtures` is a relative path to a `.json` file in the upload.
- **Vocabulary keys** belong to one contract each: `metrics` to `home_metrics`; `facts` and `modes` to `home_subject_facts`; `reasons` and `whys` to `home_queue`. A record outside its provider's declared vocabulary is dropped.
- **Identity.** `home.identity` is required when any provider sets `requires_person`. `methods` is from `native`, `email_match`, `picker`.
- **Rate.** `rate.group` matches the id pattern, and `max_dispatches_per_minute` is an integer from 1 to 60. The platform keys its counters by app, install and group.
- **Links.**
  - At most 8 `links`, each with exactly one of `page` (a path in this app starting with `/`) or `url` (https, with no credentials or port, and `{ref}` not in the host).
  - Each contains `{ref}` exactly once, and `opens_in` is a plain name.
  - A `url` host must be listed in `link_hosts`: at most 4 exact lowercase hostnames, separate from `permissions.network_domains`.

**Fixtures** (`validateHomeFixtures`, at publish): each provider's file is a JSON array of `{ name, request, vendor?, expect }` cases.
- Every request is valid for that provider, and every `expect` is a valid answer with no record the platform would drop.
- The cases cover `ok`, `empty` and `not_connected`, plus `unmapped` when the provider sets `requires_person`.
- Display strings are already clean, because fixtures are shown to tenants who have not installed the app.

## 7. Audience, actor and roles

- **`per_user`.** The platform stamps the viewer as `args.actor` (`platformUserId`) and caches the answer for that viewer. The tool must answer from **that person's own connection**, or say `not_connected`. It never falls back to another person's credential. A call with no person behind it is refused (`no_caller_identity`).
- **`company`.** No actor is stamped. One answer is cached for the company and shown to every viewer the provider's `roles` allow.
- **The identity provider** is always for a person; the platform stamps the viewer.
- **Roles.** The platform shows a provider only to the roles it declares, and enforces that on read. The app does not filter by role.

## 8. Delivery

- **Pull is the contract.** The platform asks the Home tool when a copy is missing or stale (the provider's `ttl_seconds`, shortened by `stale_after`). Copies are generation-counted per provider and per owner.
- **Invalidate.** When an app learns that vendor data changed (its own webhook or sync), it calls `env.SPRIGR.home.invalidate({ provider, owner? })`:
  - `owner` is a `platformUserId` stamped on an earlier dispatch, to make one person's copy stale; without it, every copy of the provider is stale.
  - The call carries no records, so it cannot become a push path. The platform debounces it.
  - From an inline route, where `env.SPRIGR` is absent, the same body goes to `POST /internal/wfp/home/invalidate` with the install token (`homeInvalidateBodyFor`).
- **A Home dispatch is read-only.** Its `env.SPRIGR` passes only reads (`data.search|get|listIds`, `collections.query|describe|history`, `store.get|list`, `files.get|list|job`, `jobs.get|list`, `grants.providers`, `fulfillment_services.list`, `connect.checkAgentBind`). Everything else is refused with `home_read_only`. A Home tool writes nothing to its own D1 either.
- **Budgets.** Answer inside `deadline_ms` (3500 ms), or return `rate_limited` with `retry_after_s`. Keep the answer under 64 KB.

## 9. Versioning

- Additive minor versions only.
- The platform serves a version (`HOME_CONTRACT_SERVED_VERSIONS`) before any manifest may require it.
- A new vocabulary value comes with a fixture, one per change.
- No deprecation machinery exists until a v2 is real.

Today every contract serves `1.0.0`.

## 10. What an app can never do on Home

- Send a colour, a rank, a layout, a tone, a title for a section, or a sentence joining records.
- Answer for anyone but the stamped viewer on a `per_user` provider.
- Write anything during a Home dispatch: platform data, its own D1, or an event.
- Push records. Invalidate only says "ask me again".

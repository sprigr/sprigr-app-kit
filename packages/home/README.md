# @sprigr/apps-home

The Sprigr Home contracts for marketplace apps: what an app imports to feed
the Sprigr Home (sprigr-team decisions 0170 to 0174, 0177 and 0178).

- **Types** for the five platform-owned contracts (`sprigr/home_schedule`,
  `sprigr/home_queue`, `sprigr/home_metrics`, `sprigr/home_subject_facts`,
  `sprigr/home_identity`), the request a Home tool receives as `args._home`
  (`HomeRequest`), and the answer it returns (`HomeResult`).
- **`validateHome(manifest, deps)`**: the manifest `home` block validator,
  the same one the platform runs at publish and on read.
- **`validateHomeFixtures(block, readFile)`**: the fixture-file check (states,
  the display-text rules, no record the platform would drop).
- **`checkHomeAnswer(contract, answer, ctx)`**: the answer validator the
  platform runs before caching.
- **`homeDisplayText(text, max)`**: cleans vendor text (titles, locations) to
  the Home display rules, so a record is not dropped for a "!" or a link.
- **`homeTool({...})`** and the `home.*` helpers (0.2.0): the SDK an app
  writes its one Home tool with.
- **`@sprigr/apps-home/testing`** (0.2.0): `fakeHome(manifest)` runs that
  tool the way the platform does and checks every answer;
  `fakeSprigrData(rows)` stands in for `env.SPRIGR.data`.

## Same code as the platform

Every file under `src/` except `index.ts` (extra exports), `display.ts`,
`sdk.ts` and `testing.ts` is a verbatim copy of sprigr-team
`packages/shared/src/home-contracts/` at `6bc9adf34`. `sdk.ts` and
`testing.ts` are this package's own and call only those copies, so the SDK
and the fakes apply the platform's rules, not a restatement of them. That directory imports nothing from outside itself so it can be
published unchanged. To update this package, copy the directory again and
bump the version: the platform and the apps must agree on every rule.

## Write a Home tool

The platform calls your manifest's `home.tool` (`get_<slug>_home`, `internal: true`)
with `{ provider }`, and its wrapper adds the request as `args._home` and the
viewer as `args.actor`, on a genuine Home dispatch only (sprigr-team decision
0177). `homeTool` routes on the provider and does the platform's bookkeeping
for you:

```ts
import { homeTool, identity, schedule, metrics, home } from '@sprigr/apps-home';

export const get_my_app_home = homeTool<Env>({
  // An app's own error -> a Home state. NotConnectedError (app-sdk) is already not_connected.
  mapError: (err) => (err instanceof VendorRateLimit ? { state: 'rate_limited', retry_after_s: 60 } : null),

  whoami: identity(async (env, actor) =>
    home.identity({ connection: 'personal', native_person: { vendor_person_id: '7', display_name: 'Sam' } })),

  my_day: schedule(async (env, actor, req) => {
    if (!req.person) return home.unmapped(req);
    const day = await listDay(env, actor, req.basis.window_start, req.basis.window_end);
    return home.ok(req, {
      as_of: home.utc(day.fetchedAt),
      records: day.rows.map((b) => ({
        id: b.id, kind: 'block', start: home.utc(b.start), end: home.utc(b.end),
        status: 'scheduled', category: 'job', title: `Job ${b.number}`,
        subjects: b.email ? [home.subject.email(b.email)] : [],
        ref: { id: b.jobId, label: `Job ${b.number}`, link: 'job' },
      })),
    });
  }),

  // A company-audience provider gets no actor: one answer for every viewer.
  overdue: metrics(async (env, req) => home.empty(req), { audience: 'company' }),
});
```

What `homeTool` does around each provider:

- **A person, for a `per_user` provider** (the default): it needs the
  platform-stamped `args.actor.platformUserId`. No actor, or an agent-only
  actor, is refused as `no_caller_identity` (412). That is stricter than
  app-sdk's `actorTool`, which accepts an agentId alone.
- **States, not errors:** `NotConnectedError` becomes `not_connected`, and
  `mapError` can return `not_connected`, `colleague_only`, `unmapped`,
  `error` or `{ state: 'rate_limited', retry_after_s }`. Every answer comes
  back as `{ ok: true, result }`. `{ ok: false }` is kept for plumbing faults
  (`not_a_home_dispatch`, `invalid_home_request`, `unknown_home_provider`,
  `contract_mismatch`, `no_caller_identity`) and an unmapped throw.
- **The platform's shape:** the request's `basis` is echoed, `v` is the
  highest version this package serves that is not above the request's, the
  records are emptied for any state but `ok`, and the contract's record cap
  is applied with `truncated: { at_least }`. Every record kind and field is
  1.0.0 today; when a minor adds one, `answerVersion` is where a record newer
  than the request is dropped.
- **`checkAnswers: true`** (development and tests) refuses an answer the
  platform would refuse, naming every problem.

Helpers: `home.ok`, `home.empty`, `home.notConnected`, `home.unmapped`,
`home.colleagueOnly`, `home.rateLimited`, `home.error`, `home.identity`;
`home.utc` (a Date, epoch ms or any date-time to a `Z` instant),
`home.plusMinutes`, `home.money` (major units to the currency's own minor
units), `home.sumByCurrency` (summed in minor units, unreadable rows
skipped), and `home.subject.email | abn | ref`.

## Testing: run the tool the way the platform does

```ts
import { fakeHome, fakeSprigrData } from '@sprigr/apps-home/testing';
import manifest from '../sprigr-app.json';

const h = fakeHome(manifest, { readFile: (p) => readFileSync(join(appDir, p), 'utf8') });

// Every case of every provider's fixtures file, through the real tool:
const runs = await h.runFixtures(get_my_app_home, { env: (c) => envFor(c.vendor) });
for (const r of runs) {
  expect(r.problems, r.case).toEqual([]);     // what the platform would refuse
  expect(r.dropped, r.case).toEqual([]);      // records it would drop
  expect(r.matchesExpect, r.case).toBe(true); // the case's `expect`, exactly
}

// One call, with a request the platform would send:
const res = await h.call(get_my_app_home, 'my_day', { env, request: h.request('my_day', { day: '2026-10-04', tz: 'Australia/Sydney' }) });

// env.SPRIGR.data, which `sprigr app dev` does not provide. Read-only, like a Home dispatch:
const data = fakeSprigrData([{ objectID: 'inv-1', _tenant_id: 't1', amountDue: 10 }]);
```

`fakeHome` throws when the manifest's `home` block is one the platform would
refuse. It stamps `FAKE_HOME_VIEWER` on a person's provider (pass `actor`, or
`actor: null` to see the refusal). `request()` builds the platform's
local-midnight window for the day and zone, daylight saving included.
`fakeSprigrData` supports `field:value` filters joined by commas,
`sortBy: 'field:asc|desc'`, paging and `attributesToRetrieve`. Every write
rejects with `err.code === 'home_read_only'` and is listed in
`refusedWrites`.

## Lower level

```ts
import { checkHomeAnswer, homeDisplayText, type HomeRequest, type HomeResult, type ScheduleRecord } from '@sprigr/apps-home';
```

`validateHome` needs the platform's dispatch classifier passed in
(`{ isReadShapedDispatch }`), because that rule lives in the platform; a test
can pass `(name, effects) => effects !== 'write' && /^(get|list|search)_/.test(name)`.

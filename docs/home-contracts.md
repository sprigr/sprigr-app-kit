# Feeding the Sprigr Home

The Sprigr Home is each person's day: their jobs on a timeline, what needs them, the money that matters, and a prep line joining a job to its customer's overdue invoice. Apps feed it data; the platform decides every word, colour and position. This guide walks through building that, from the manifest to a tested Home tool. The normative rules are in [`docs/interfaces/sprigr-home-v1.md`](interfaces/sprigr-home-v1.md).

## 1. The model in one minute

- **Five contracts, owned by the platform:**
  - `sprigr/home_schedule` (time on the day);
  - `sprigr/home_queue` (things that need someone);
  - `sprigr/home_metrics` (numbers);
  - `sprigr/home_subject_facts` (facts about a customer or job, joined across apps);
  - `sprigr/home_identity` (who the viewer is in your system).
- **One Home tool** per app, `get_<slug>_home`, read-only and platform-only. The platform calls it with `{ provider }`, and its wrapper adds the request as `args._home` and the viewer as `args.actor`.
- **You send data, never presentation:** your own ids, UTC instants, integer minor-unit money, and values from closed lists. No colours, ranks, layouts or sentences.
- **Pull, with a nudge.** The platform asks when its copy is stale. When your webhook learns something changed, call `env.SPRIGR.home.invalidate({ provider })` to say "ask me again". You never push records.

## 2. Declare it in the manifest

Add the tool to `tools[]` (with `internal: true`) and a `home` block:

```json
"tools": [
  { "name": "get_my_app_home", "internal": true, "handler": "src/handlers/home.ts",
    "description": "Platform-only: answers Sprigr Home contracts for one provider id",
    "input_schema": { "type": "object", "properties": { "provider": { "type": "string" } }, "required": ["provider"] } }
],
"home": {
  "tool": "get_my_app_home",
  "links": [{ "id": "job", "page": "/jobs/{ref}", "opens_in": "My App" }],
  "identity": { "contract": "sprigr/home_identity", "version": "^1.0", "provider": "whoami", "methods": ["native", "email_match"] },
  "rate": { "group": "my_app", "max_dispatches_per_minute": 30 },
  "provides": [
    { "id": "my_day", "contract": "sprigr/home_schedule", "version": "^1.0", "scope": "me", "audience": "per_user",
      "roles": ["owner", "admin", "manager", "member"], "requires_person": true, "ttl_seconds": 900,
      "fixtures": "home/fixtures/my_day.json" },
    { "id": "money", "contract": "sprigr/home_metrics", "version": "^1.0", "scope": "company", "audience": "company",
      "roles": ["owner", "admin"], "metrics": ["receivables.overdue"], "ttl_seconds": 1800,
      "fixtures": "home/fixtures/money.json" }
  ]
}
```

Choices that matter:

- **`audience`.** For `per_user`, the platform stamps the viewer and caches per person, and you answer from **their own** connection or say `not_connected`. For `company`, there is no actor and one answer serves everyone the `roles` allow.
- **`scope`.** `me` (the viewer's own), `crew` (their team; only for `owner`, `admin`, `manager`) or `company`.
- **`requires_person`.** Set it when you can only answer for a person in your system. The platform finds the viewer's person through your identity provider, and you return `unmapped` when there is none.
- **`roles`.** The platform shows a provider only to these roles. Don't filter by role yourself.

Check it locally with `validateHome` from `@sprigr/apps-home`; the platform runs the same validator at publish.

## 3. Write the Home tool with `homeTool`

```ts
// src/handlers/home.ts
import { homeTool, identity, schedule, metrics, home } from '@sprigr/apps-home';

export const get_my_app_home = homeTool<Env>({
  // Your own errors to Home states. NotConnectedError is already not_connected.
  mapError: (err) => (err instanceof VendorRateLimit ? { state: 'rate_limited', retry_after_s: 60 } : null),

  whoami: identity(async (env, actor) => {
    const me = await vendorWhoAmI(env, actor);             // throws NotConnectedError if they have no connection
    return home.identity({ connection: 'personal', native_person: { vendor_person_id: me.id, display_name: me.name } });
  }),

  my_day: schedule(async (env, actor, req) => {
    if (!req.person) return home.unmapped(req);
    const day = await listBookings(env, actor, req.person.vendor_person_id, req.basis.window_start, req.basis.window_end);
    return home.ok(req, {
      as_of: home.utc(day.fetchedAt),
      records: day.rows.map((b) => ({
        id: `b-${b.id}`, kind: 'block', start: home.utc(b.start), end: home.utc(b.end),
        status: 'scheduled', category: 'job', title: `Job ${b.number}`,
        location: b.address ? { text: b.address } : undefined,
        subjects: b.email ? [home.subject.email(b.email)] : [],
        ref: { id: b.jobId, label: `Job ${b.number}`, link: 'job' },
      })),
    });
  }),

  money: metrics(async (env, req) => {
    const rows = (await env.SPRIGR.data.search({ filters: 'status:AUTHORISED', hitsPerPage: 100 })).hits;
    const overdue = rows.filter((r) => String(r.dueDate) < req.basis.day);   // dueDate stored as YYYY-MM-DD
    if (overdue.length === 0) return home.empty(req);
    return home.ok(req, {
      as_of: home.utc(Date.now()),
      records: home.sumByCurrency(overdue, 'amountDue', 'currencyCode').map((c) => ({
        metric: 'receivables.overdue', value: { kind: 'money', amount: home.money(c.total, c.currency) },
        count: c.count, period: { kind: 'instant' },
      })),
    });
  }, { audience: 'company' }),
});
```

What `homeTool` does for you:

- **Routing and the person rule.** It routes on the provider. A person's provider gets the stamped viewer, and a call with no person behind it (including an agent-only actor) is refused as `no_caller_identity`.
- **States, not errors.** `NotConnectedError` becomes `not_connected`, and `mapError` maps your own errors. Every answer, whatever its state, goes back as an answer.
- **The bookkeeping.** It echoes `basis`, sets `v`, empties the records of any state but `ok`, and applies the record cap with `truncated`.

Pitfalls the platform catches, and what to do instead:

- **Day boundaries.** Use `req.basis.day` and the window, never `new Date()`'s UTC date. 00:30 in Brisbane is still the previous day in UTC.
- **Display text.** A record whose title or location carries markup, a URL, an emoji or a `!` is dropped. Clean vendor text with `homeDisplayText(text, 80)`.
- **Money.** Integer minor units: `home.money(12.5, 'AUD')` is `{ minor: 1250, currency: 'AUD' }`. `home.sumByCurrency` adds in minor units, so float drift never shows.
- **A Home dispatch is read-only.** `env.SPRIGR` passes only reads (`data.search`, `data.get`, `store.get`, ...), and a write rejects with `home_read_only`. Don't write to your own D1 either.
- **Budget.** Answer within about 3.5 s, or return `home.rateLimited(req, seconds)`.

## 4. Tell the platform when your data changed

In a webhook or sync handler, after your own write:

```ts
await env.SPRIGR.home.invalidate({ provider: 'my_day' });                       // every viewer's copy
await env.SPRIGR.home.invalidate({ provider: 'my_day', owner: platformUserId }); // one person's copy
```

It carries no records, never throws, and is debounced by the platform. From an inline route, where `env.SPRIGR` is absent, post the same body (`homeInvalidateBodyFor`) to `/internal/wfp/home/invalidate` with the install token.

## 5. Fixtures

Each provider names a fixtures file: a JSON array of `{ name, request, vendor?, expect }` cases.
- Cover `ok`, `empty` and `not_connected`, plus `unmapped` for a `requires_person` provider.
- Keep display strings clean: fixtures are shown to people who haven't installed your app yet.
- The platform checks the file at publish (`validateHomeFixtures`).

## 6. Test it

`@sprigr/apps-home/testing` runs your tool the way the platform does and checks every answer with the platform's rules:

```ts
import { fakeHome, fakeSprigrData } from '@sprigr/apps-home/testing';
import manifest from '../sprigr-app.json';

const h = fakeHome(manifest, { readFile: (p) => readFileSync(join(appDir, p), 'utf8') });
const runs = await h.runFixtures(get_my_app_home, { env: (c) => envFor(c.vendor) });
for (const r of runs) {
  expect(r.problems, r.case).toEqual([]);   // what the platform would refuse
  expect(r.dropped, r.case).toEqual([]);    // records it would drop
  expect(r.matchesExpect, r.case).toBe(true);
}
```

- `fakeHome.request(provider, { day, tz })` builds the request the platform would send, daylight saving included.
- `fakeSprigrData(rows)` stands in for `env.SPRIGR.data`, which `sprigr app dev` does not provide. It is read-only, like a Home dispatch.

Then run the conformance suite, `@sprigr/apps-home-conformance`, once per app:

```ts
import { describeHomeConformance } from '@sprigr/apps-home-conformance/vitest';
describeHomeConformance('my-app', { manifest, tool: get_my_app_home, env: fakeEnv });
```

It checks, per provider:
- basis echo either side of local midnight;
- the person rule, including an agent-only actor;
- that two people never see each other's records;
- no D1 writes and no `env.SPRIGR` writes;
- 64 KB;
- the time budget.

Your test env connects its two test people (`usr_conformance_a`, `usr_conformance_b`) to vendor accounts of their own, each with records.

## 7. See it before you publish

Coming with the next Sprigr CLI release (sprigr-team#11068); not in a published CLI yet:

- `sprigr app dev --dir <dir> --home` sends every fixture case through your local `sprigr app dev` server and reports `ok`, `REFUSED` or `FAILED` per case, flagging anything over 2 s.
- `sprigr app home preview --dir <dir>` uploads your fixtures' answers and prints a link that draws them with Home's own components. Add `--live` to preview one real day from a running `sprigr app dev`, labelled REAL DATA.
- A preview is private to you, lasts 15 minutes, and saves nothing.

## 8. Checklist

- [ ] `home` block passes `validateHome`; the tool is `get_<slug>_home`, `internal: true`, in `tools[]`.
- [ ] Each provider's `audience`, `scope`, `roles` and `requires_person` say who it answers for.
- [ ] Fixtures cover `ok`, `empty`, `not_connected` (and `unmapped`), with clean display text.
- [ ] The tool is built with `homeTool`, and `fakeHome.runFixtures` is green.
- [ ] `describeHomeConformance` is green.
- [ ] Webhooks and syncs call `env.SPRIGR.home.invalidate` after the data behind a provider changes.

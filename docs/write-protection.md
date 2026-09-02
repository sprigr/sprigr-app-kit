# Write protection: confirmation, approval, undo

A marketplace app tool can mutate anything it has scopes for. The platform gives you three tiers of protection, and they are not substitutes for each other. This page says which to use where, and how the SDK helpers fit. Platform decisions: sprigr-team 0009 (confirmation policy and `_approval`), 0011 (`_undo`), 0012 (approval grants are stored and replayed).

| Tier | Mechanism | Who attests | What it buys |
| --- | --- | --- | --- |
| T1 Confirmation policy | manifest `tools[].confirmation` | the model sets `confirm: true` | a reviewable declaration and an audit trail. Measured on staging: the model pre-confirms from the user's own request, so on its own this stops nothing |
| T2 Approval | handler returns `_approval` instead of writing; re-dispatched with `_approval_granted` after a tap | a human, via the platform's decision card | the only real control. Fails open on autonomous runs (schedules, workflow steps, delegations); grants expire in 15 minutes |
| T3 Undo | handler returns `_undo` beside a successful write; manifest `undo.reverse_tool` names an `internal: true` tool | platform mints a single-use 7-day token | a reversal after the write landed |

Plus one app-side pattern: **archive-first**. Where the vendor has a real archived state, a `delete_*` refuses without `force: true` and offers the archive. Same id, real restore, no fidelity caveat. Prefer it to a journal.

## Which tools get which tier

- Every write that is destructive, moves money, or notifies someone: **T1 with `irreversible: true`**, and **T2**.
- Every other write that a person will reconcile against (ledger entries, account settings): **T1 `always`**.
- Bulk writes whose risk is proportional to batch size: **T1 `when: { count, atLeast }`** on a real array. Never threshold a money field: a numeric string never trips.
- Routine record keeping (contacts, items, notes): ungated, but listed explicitly as ungated so the choice is reviewable.
- Writes you can read back before overwriting or recreate from a copy: **T3**, with honest `fidelity`.
- **Never T3 for money or messages.** There is no un-charge, and an agent that sees an undo affordance will offer it.

## T1: declare the policy beside the code

For a dispatcher tool (one tool, many actions), keep the policy in TypeScript next to the action registry, emit it into `sprigr-app.json` with a `gen:` script, and let a test prove coverage:

```ts
// src/handlers/actions/confirmation-policy.ts
import { buildConfirmationPolicy } from '@sprigr/apps-app-sdk';

export const UNGATED_WRITES = ['create_contact', 'update_contact'] as const;

export const policy = buildConfirmationPolicy({
  irreversible: {
    void_invoice: 'Void invoice {input.id}, which Xero cannot un-void',
    email_invoice: 'Email invoice {input.id} to the customer',
  },
  always: {
    create_payment: 'Record a payment of {input.amount} against invoice {input.invoice_id}',
  },
  rules: {
    authorise_invoices: { when: { count: 'input.invoice_ids', atLeast: 10 }, describe: 'Authorise {input.invoice_ids.length} invoices' },
  },
});
```

```ts
// __tests__/confirmation-policy.test.ts
import { checkConfirmationPolicy } from '@sprigr/apps-app-sdk';
it('every write is gated or knowingly exempt, and every placeholder resolves', () => {
  expect(checkConfirmationPolicy({
    policy,
    registry: ACTIONS.keys(),
    ungated: UNGATED_WRITES,
    requiredInput: (a) => ACTIONS.get(a)?.requiredInput,
  })).toEqual([]);
});
```

Two traps the checker catches, both silent on the platform: a placeholder not dotted through `input.` on a `{ action, input }` tool renders as "(unset)" on the card; a rule keyed on a misspelled action gates nothing.

For flat tools (one tool, one job) the policy is a tool-level rule per tool name. Keep those in the same TypeScript module and let the `gen:` script write them with `applyConfirmationPolicies`, which also retires the two mechanisms a policy supersedes: the legacy `confirmation_required: true` flag (sugar for `{ always: true }` with no `describe`) and any app-declared `confirm` input (the platform injects its own top-level `confirm` wherever a policy is present):

```ts
// scripts/gen-confirmation-manifest.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { applyConfirmationPolicies, serializeManifest, type ManifestLike } from '@sprigr/apps-app-sdk';
import { CONFIRMATION_RULES } from '../src/handlers/confirmation-policy';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestLike;
applyConfirmationPolicies(manifest, { policies: CONFIRMATION_RULES });   // throws on a tool name the manifest lacks
writeFileSync(MANIFEST_PATH, serializeManifest(manifest));
```

```ts
// __tests__/confirmation-policy.test.ts
import { manifestIsFresh, checkConfirmationPolicy } from '@sprigr/apps-app-sdk';
it('the committed manifest is a fresh generation', () => {
  expect(manifestIsFresh(manifest, { policies: CONFIRMATION_RULES })).toBe(true);
});
it('every rule is live and every placeholder is a required input', () => {
  expect(checkConfirmationPolicy({
    policy: { actions: { ...CONFIRMATION_RULES } },   // tool-level rules, checked as if actions on one dispatcher
    registry: manifest.tools.map((t) => t.name),
    writePrefixes: [],                                 // or the app's verb list, with `ungated` for the deliberate exemptions
    nestedUnderInput: false,
    requiredInput: (name) => requiredOf(name),
  })).toEqual([]);
});
```

Pass `dispatch` alongside `policies` to write a dispatcher's `dispatch` block in the same pass.

## T2: `requireApproval`

```ts
import { requireApproval, set, type ApprovalSpec } from '@sprigr/apps-app-sdk';

const SPECS: Record<string, ApprovalSpec<MyEnv>> = {
  acme_delete_thing: {
    keys: ['thing_id', 'id'],
    describe: (target, _args, connection) => ({
      question: `Permanently delete thing ${target} on ${connection}?`,
      header: 'Acme',
      summary: 'Cannot be undone. Acme never reissues the id.',
    }),
    undo: {                                   // only if a copy can be rebuilt
      resource: 'thing',
      fidelity: 'recreated',
      capture: (pinnedEnv, id) => getThing(pinnedEnv, id),
      describe: (before, id) => `thing "${before.name ?? id}"`,
      warning: () => 'Reversing creates a NEW thing under a new id; the old id stays broken.',
    },
  },
  acme_add_tags: {
    keys: ['id'],
    describe: (target) => ({ question: `Add tags to ${target}?`, header: 'Acme' }),
    hash: (args) => [set(args.tags)],         // order-insensitive identity
  },
};

Object.assign(registry, requireApproval(registry, SPECS, {
  scope: 'acme-undo',
  resolveConnection: async (env, args) => resolveAccount(env, args),   // canonical, from the install
  pinEnv: (env, account) => withAccount(env, account),
  describeTarget: (pinnedEnv, id) => labelFor(pinnedEnv, id),           // falls back to the id
  journal: (env) => createUndoJournal({ db: env.DB, table: 'acme_undo_journal', scope: 'acme-undo' }),
  stampConnection: (result, account) => ({ ...(result as object), account }),
}));
```

What the wrapper guarantees:

- The **connection is resolved and pinned inside the wrapper**, before the label lookup, the hash and the capture. An approval gate that sits outside the app's own pin sees the install's default connection and gets all three wrong. Shopify shipped exactly that.
- The **hash is `rawId + connection + your extra parts`**, so a tap survives the model dropping `store` on the retry. Never put `confirm` in it.
- On the granted pass it **captures before the write, mints only after the write reported `ok`**, and never returns `_undo` when the capture or the journal failed. A failed capture does not fail the write.
- A spec naming a tool absent from the registry **throws at build time** rather than silently ungating a rename.

Autonomous runs fail open by design: a scheduled task or workflow step has no one to ask, so the platform returns the question with a note that nothing was written. Scope what a background agent may do; do not rely on `_approval` there.

### Dispatcher tools

A dispatcher (one tool, many actions) cannot wrap handlers, so it builds the gate once and calls it from the dispatch loop:

```ts
const gate = dispatcherApproval<AcmeEnv, AcmeState>(SPECS, {
  scope: 'acme-undo',
  inputField: 'params',                                   // default 'input'
  resolveConnection: async (env, params) => resolveAccount(env, params),
  pinEnv: (env, account) => stateFor(env, account),        // what capture / describeTarget receive
  describeTarget: (state, id) => labelFor(state, id),
  journal: (env) => createUndoJournal({ db: env.DB, table: 'acme_undo_journal', scope: 'acme-undo' }),
});

// in the dispatcher, once the action is resolved and its params parsed:
return gate.run(action, args, env, () => def.execute(state, parsed));
```

`SPECS` is keyed by action name; per-module spec maps compose with an object spread. The action name goes into the grant hash because every action shares one tool and the platform only mixes in the tool name. `describeTarget(pinned, id, action)` receives the action so a dispatcher can route the label lookup by resource type when the id alone does not say what it is.

Keep the two tiers from drifting with two containment assertions in a test, against pinned lists: every `irreversible: true` action has an approval spec, and every approval-gated action is T1 `always`. They are containments, not an equality: a gated action can still carry a working undo (a recreate, a deletion of the thing that was posted), and `irreversible` there would put "cannot be undone" beside an undo token.

## T3: the reverse tool

Declare it in the manifest and keep it off the agent's list:

```jsonc
{ "undo": { "reverse_tool": "acme_undo_apply" },
  "tools": [ { "name": "acme_undo_apply", "internal": true, "handler": "src/handlers/undo-apply.ts", "input_schema": { "type": "object", "properties": { "ref": { "type": "string" }, "undo_token": { "type": "string" } } } } ] }
```

```ts
import { runUndoApply } from '@sprigr/apps-app-sdk';

export const acme_undo_apply = (args, env: MyEnv) =>
  runUndoApply(args, {
    env,
    journal: createUndoJournal({ db: env.DB, table: 'acme_undo_journal', scope: 'acme-undo' }),
    specs: { acme_delete_thing: { resource: 'thing', fidelity: 'recreated', restore: (pinnedEnv, before) => recreateThing(pinnedEnv, before) } },
    pin: (env, connection) => withAccount(env, connection),   // or return null to REFUSE on a mismatch
  });
```

The platform dispatches the reversal with **no memory of which connection the original write hit**. Per-call apps (the caller passes `store` / `organisation` on each call) must pin from the journalled row; session-stateful apps (a `select_business` action) may refuse instead by returning `null` from `pin`. Either way the connection is in the row, and in `describes`.

The journal migration is a literal `.sql` file; generate the DDL once with `undoJournalSchemaSql('acme_undo_journal')` from `@sprigr/apps-undo-journal` and paste it.

## The lint

`sprigr-check-write-protection` ships as a bin with the SDK. It scans every `apps/*/sprigr-app.json` and fails on a tool, or an enumerated dispatcher action, whose name is destructive (`delete`, `remove`, `cancel`, `void`, `refund`, `unship`, `rotate`, `offboard`, `purge`, `clear`, `reset`, `revoke`, `unregister`, `force`, `deactivate`, `suspend`, `destroy`, `capture_payment`, `complete_draft`) and that carries no `confirmation` entry. A dispatcher that does not enumerate its actions cannot be inspected and is a finding until it does.

- `apps/<app>/write-protection.json`: `{ "allow": { "acme_refund_rate": "a read; reports the refund ratio" } }`. Every entry needs a reason; a stale entry fails.
- `tools/write-protection-baseline.json`: the ratchet. `--write-baseline` banks the current state; anything new fails; anything fixed must be banked.
- `--warn` reports without failing, for the first weeks of a rollout.

## Verifying on staging

Each tier has a different proof, and a transcript is not one of them:

- T1: read the model's reasoning for the bounce and its re-call with `confirm: true`. "No bounce visible" usually means the model pre-confirmed, not that the guard is broken.
- T2: drive from the portal, not MCP (an MCP run is autonomous and fails open). Tap on the non-default connection. The `payloadHash` in the transcript must be identical on the ask and the retry.
- T3: from a fresh conversation, ask for the reversal. The proof is a journal row that disappeared plus the platform's token row marked reversed. Asked to "undo", a model with the old value in context will simply re-write the field, and the reply reads identically.

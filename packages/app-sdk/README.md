# @sprigr/apps-app-sdk

Shared handler types + helpers for Sprigr marketplace apps.

```bash
npm install @sprigr/apps-app-sdk
```

## Talking to the platform

The runtime injects the `env.SPRIGR` host object **only on `/__sprigr/*` dispatch paths** (tool, schedule, event and platform-webhook handlers). Inline Next.js route handlers never get it, so an app that receives its provider webhook on an inline route has no working `env.SPRIGR` on the path that matters most.

- `emitMarketplaceEvent(env, event, payload, opts?)` — emit from either context. Uses the injected binding when present, the install-token bridge (`POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/emit`) otherwise. Never throws, so a webhook ack is never at risk; times out after 5s. Returns `{ emitted, via: 'binding' | 'http' | 'none', eventId?, error? }` — record `via` in your audit row.
- `createMarketplaceEmitter(integrationType, defaults?)` — pre-bind an app's integration type so call sites pass only what varies; `sourceIntegration` is built per call from `env.INSTALL_ID`.
- `canEmit(env)` — whether an emit could reach the platform by either transport. Gate work that only exists to feed an emit on this, not on `env.SPRIGR?.emit`.
- `withSprigrEmitFallback(env)` — repair `env.SPRIGR.emit` once and leave existing call sites untouched. Matches the host object's contract (resolves `{ ok, eventId, queued }`, throws on non-2xx).
- `logToPlatform(env, entry | entry[], opts?)`: durable app logging from either context (`env.SPRIGR.log` on dispatch, `POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/log` from an inline route). Rows land in the platform's `system_logs` Analytics Engine dataset (90-day retention, scoped to the install's company, category prefixed with the app slug), so use it instead of a per-webhook or per-tick audit row in your D1: D1 bills every row written, AE does not. Validation throws synchronously on a cap violation (summary 256, detail 4096, metadata JSON 3840, category 64 matching `[A-Za-z0-9._:-]`, 50 entries per call; nothing is ever truncated); after that the promise never rejects and resolves `{ ok: true, written }` or `{ ok: false, error, status?, detail? }`. Pass `{ waitUntil: ctx.waitUntil.bind(ctx) }` on an inline route so the send outlives the response. `withSprigrLogFallback(env, opts?)` installs `env.SPRIGR.log` once for many call sites; `canLog(env)` gates work whose only purpose is a log row; the `SprigrLogEntry` / `SprigrLogFn` types let your env interface declare the host member.
- `partialUpdateData(env, objects, opts?)`: merge fields into objects already in the app's data index without reading them first (`env.SPRIGR.data.partialUpdate` on dispatch, `POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/data/partial-update` from an inline route). Deep merge: nested objects recurse, arrays and scalars replace wholesale, absent keys survive, `null` overwrites. `createIfNotExists` defaults to `false`; on a sharded logical index every patch must carry the `shard_field` value or the batch fails with `shard_field_invalid`; 1000 objects per call like `import`. Throws on a bad batch before sending (`SprigrDataValidationError`) and on a platform rejection (`.status`, `.error`, `.detail` on the `Error`), the same contract as `import`. With `{ withAcl: true }` it patches existing rows of the app's `-acl-files` index: each object carries `objectID` plus `acl_principals` and/or label fields the manifest declares in `data_index.acl_patchable_fields` (never `content`), and an object that omits `acl_principals` keeps its stored ones. `canPartialUpdate(env)` gates a patch step on either transport; the `SprigrDataPartialUpdateOpts` / `SprigrDataPartialUpdateResult` types let your env interface declare the host member.
- `resolveInstallBridge(env)` / `installTokenPost(bridge, path, body, opts?)`: build your own `/internal/wfp/*` fallback (collections, files, inbox) with the auth and error extraction handled. A non-2xx throws an `Error` whose `.status`, `.error` (the platform's code) and `.detail` are set alongside the message.
- `overlaySprigr(env, sprigr)` — overlay a patched `SPRIGR` via `Object.create`. Never rebuild a dispatch-path env by spread: the real bindings live on the prototype and `SPRIGR` is non-enumerable, so `{ ...env }` yields an env whose `DB` is `undefined`.

## Per-actor tool wrappers

An agent-facing tool must resolve the **calling** identity's own credential, or refuse. It must never fall back to another connected account, not even for a read: an install is company-wide, but access is not.

```ts
// src/handlers/wrap.ts: bind the options once
import { createToolWrappers, NotConnectedError } from '@sprigr/apps-app-sdk';

export const { tool, actorTool } = createToolWrappers<MyEnv>({
  notConnectedHint: 'Call my_connect and send the user the link.',
  mapError: (err) =>
    err instanceof MyApiError ? { error: err.message, status: err.status } : null,
});

// src/handlers/things.ts
export default { list_things: actorTool(async (env, actor, args) => { /* ... */ }) };
```

- `actorTool(fn)`: reads the platform-stamped `args.actor`, returns `412 no_caller_identity` when it is absent, and maps a thrown `NotConnectedError` to `412 not_connected` with your connect hint. Identity comes only from the nested `args.actor`; flat body fields are agent-supplied and spoofable.
- `tool(fn)`: for handlers with genuinely no caller (schedules, webhooks, platform mirrors). Those need a *designated service connection*, which is not licence for an agent-facing handler to borrow one.
- `NotConnectedError`: throw from your token resolver when the **caller** has no connection. Don't throw it for "the install has none", which is a different fault with a different fix.
- `isNotConnectedError(err)`: matches by class *and* by `name`, so it still works when the vendor pattern puts two copies of this module in one isolate and `instanceof` would silently fail.

**Why this is in the SDK:** every app hand-rolled this, and one shipped a version that fell back to "the first connected actor on the install" when the caller had none. One person's consent then exposed their account to every agent on that install, in production.

## Retiring a person or agent: `on_actor_retired`

A per-actor app must forget a person when the platform does. When a member is removed, an agent is deleted, a companion's bound user id is corrected, or an operator retires an orphaned key, the platform POSTs `/__sprigr/tool/on_actor_retired` to every install that declares a tool of that name (sprigr-team decision 0154). Run the same revoke-and-purge your own disconnect tool runs, for that key only.

```ts
import { actorRetiredHook } from '@sprigr/apps-app-sdk';

export default {
  on_actor_retired: actorRetiredHook<MyEnv>(async (env, retired) => {
    // retired.actor is shaped like a stamped actor: actorKey(retired.actor) === retired.actorKey
    await revokeAndPurge(env, retired.actor, { cutoff: retired.requestedAt, ownerRef: retired.storageOwnerRef });
    return { done: true };
  }),
};
```

- Declare it in `tools[]` with `"internal": true`. The platform never lets an agent or the app bridge call it.
- `actorRetiredHook` refuses a call that carries `args.actor` (the platform's dispatch never does) and a malformed body, by throwing. It never turns a throw into `{ ok: false }`: the platform reads `done`, and a swallowed error would read as finished. A throw is retried.
- Return `{ done: true }` when finished or durably queued by the app; `{ done: false, remaining }` to be called again (1 min up to 12 h, 8 deliveries). Be idempotent.
- `successorKey` is audit only: never move the grant or the data to it. Delete only what existed by `requestedAt`.
- `storageOwnerRef` is the `owner_ref` a no-actor maintenance `env.SPRIGR.files.list` reports for this person's per-user stored files; pass it to a no-actor `files.delete(key, { owner_ref })`.
- For a user who disconnects while still a member, call `env.SPRIGR.files.purgeOwner()` on their own dispatch instead: it deletes their per-user files uploaded before the call and keeps anything written after (typed on `SprigrFilesApi` from 0.40.0, sprigr-team#13242).

## Webhook callback URLs

- `resolvePlatformWebhookBase(env)` / `buildMarketplaceWebhookUrl(env, installId, topicPath)` — env-correct platform host, so a staging install never registers prod-pointing subscriptions.

## Misc

- `fetchWithRetry` — rate-limit-header-aware, jittered retry
- `constantTimeEqual(a, b)` — bearer-secret verification
- `encodeState` / `decodeState` — OAuth state base64url
- `encodeStateWithinEnvelope(state, { installId, appSlug, optional? })` — `encodeState` that leaves room for the platform's signed envelope (500 chars, decision 0190). An optional field (default `returnTo`) that does not fit is left out whole, never shortened, with a `console.warn` naming the lengths; without `returnTo` the bouncer lands the user on the install's dashboard. Use it for any state that carries a caller-supplied value. `oauthStateEnvelopeOverhead` and `OAUTH_STATE_ENVELOPE_MAX_CHARS` expose the arithmetic.
- `parseActor` / `actorKey` / `ownerFromActorKey` — per-actor token scoping
- `Actor.surface` / `Actor.personId` / `Actor.personSource` (0.33.0, sprigr-team decision 0305): who is asking and from where. `platformUserId` is the agent's bound user (whose credentials you act with) on every turn, including a website visitor's, so gate a person's own records on `personId` and public-vs-staff answers on `surface`. Treat a missing `surface` as public. Trust level: transport-trusted like `platformUserId`, set by the platform, stripped from caller input, and not verifiable by the app. `personSource` also takes `workflow_starter` (sprigr-team#13083) and `delegation_originator` (sprigr-team#13005) from 0.39.0; an app that opens data only for a stamped person treats both as it treats `workflow_saver`. Before 0.39.0, `parseActor` dropped them and kept `personId` with no `personSource`.
- `putAppFile` / `putAppFileStream` / `appFileUrl` / `getAppFile` / `listAppFiles` / `deleteAppFile` — durable app-scoped file storage from outside the injected bridge
- `fetchFileBytes` / `fetchFileAsBase64` / `bytesToBase64` / `base64ToBytes` — file byte helpers. The fetches take only Sprigr file links (`SPRIGR_FILE_HOSTS`, https) unless you pass `allowedHosts` (a list, or `'any'` for a public URL by design, which still refuses a private IP literal in any spelling the URL parser produces (decimal, octal, hex, IPv4 embedded in IPv6, a trailing dot; 0.35.1, sprigr-app-kit#189), `localhost` and `*.local`; it does not resolve hostnames or stop redirects); a refused URL throws `FileUrlRefusedError` before any request. `assertFetchableFileUrl` runs the same check at input time. **Breaking in 0.35.0:** the default refuses every host except the Sprigr file hosts. On bumping: procore passes a public `source_url` by design and must set `allowedHosts: 'any'`; quickbooks accepts any https URL today and narrows to Sprigr file links; fastmail and trello already check for `*.sprigr.com` and narrow to the two file hosts.
- `readableStoredKey(appKey, downloadUrl)` / `agentFileKeyFromUrl` — turn the install-relative key your app stored a file under into the absolute key the platform's `read_file` tool opens (read off the signed URL `appFileUrl` minted). Return it as a tool's `file_key` so an agent can open the file. `appKeyFromCallerKey` / `callerKeyRefusal` go the other way, for a key an agent hands back to your tool (0.17.0)
- `readFileRef(env, { file_key } | { file_url }, { maxBytes })` / `resolveFileRef`: accept a file an agent hands your tool. `resolveFileRef` only validates (run it before an approval card): a key in this install's store in any form, or an https link on `files.sprigr.com` (a link into this install is read as its key; a company link must be signed and in this company; workspace keys, other installs and every other host are refused with a `FileRefError` whose message says what to pass instead). `readFileRef` then reads the bytes with a size cap, a 20 s time cap and no redirects; `openFileRef` does the same as a stream, for a large attachment passed on without buffering. `FILE_REF_SOURCES_HELP` is the agent-facing list of accepted sources, for a tool's input description (0.21.0)
- `getCompanyTimezone(env)`: the company's IANA zone from the platform's `COMPANY_TIMEZONE` binding, or `undefined` when the company has none or the value is not a zone `Intl` accepts. Never throws and never defaults; the app picks its own fallback (0.24.0)
- `pruneAuditTable(db, { table, timeColumn, timeFormat, retentionMs, idColumn?, batch?, max?, now? })`: delete an audit table's rows older than `retentionMs`, oldest first, at most `batch` (1000) per statement and `max` (5000) per call. Resolves `{ deleted, more }`; `more` is true when `max` was reached and the next call carries on. `timeFormat` is `'epoch_ms'` (a `Date.now()` integer) or `'sqlite_datetime'` (the text `datetime('now')` writes). It walks the integer primary key (`idColumn`, default `id`; `'rowid'` for a table without one), so it needs no index on the time column and reads at most `batch` rows per statement. Identifiers must be plain SQL names; anything else throws before D1 is touched. A D1 error rejects, so wrap the call when it rides on a tick that must not fail. Run it from an existing low-frequency tick, and keep routine successes out of the table in the first place: they belong in `logToPlatform` (0.38.0, sprigr-apps#4001)

Full platform semantics: [`docs/platform-reference.md`](../../docs/platform-reference.md).

## Dispatch manifest: `buildDispatchManifest`

For an app whose dispatcher tool routes many actions through one `action` field, generate the tool's manifest `dispatch` block from the action registry instead of hand-keeping it:

```ts
import { buildDispatchManifest, buildParamsDescription } from '@sprigr/apps-app-sdk';

// Keyed by CALLABLE name, aliases included; map your own ActionDef fields.
const registry = new Map([...ACTIONS].map(([key, def]) => [key, {
  name: def.name, description: def.description, summary: def.summary,
  accepts: def.accepts, required: def.requiredInput,
}]));
tool.dispatch = buildDispatchManifest(registry);
tool.input_schema.properties.input.description = buildParamsDescription(tool.dispatch.actionInputs);
```

- `actions`: every callable name, sorted.
- `actionInputs`: only actions that declare `accepts`, keyed by canonical name. Declare `accepts` only when it is complete, because the platform refuses any other key before dispatch.
- `actionDescriptions`: one line per action (its `summary`, else the first sentence of `description`, capped at 160 chars with a visible `...`). A code_mode agent sees it under the action in `tools.describe('<app>', { match })`.

Keep the generator's manifest I/O and any confirmation or idempotency policy in the app.

## Write protection

Three platform tiers, and they are not substitutes for each other. Full guide: [`docs/write-protection.md`](../../docs/write-protection.md).

| Tier | Where | Who attests | Helper |
|---|---|---|---|
| T1 confirmation policy | manifest `tools[].confirmation` | the model (`confirm: true`) | `buildConfirmationPolicy` + `checkConfirmationPolicy`, `sprigr-check-write-protection` |
| T2 approval | handler returns `_approval` | a human tap | `requireApproval`, `approvalHash` / `set` / `seq` |
| T3 undo | handler returns `_undo`; manifest `undo.reverse_tool` | platform token | `requireApproval` (capture), `undoEnvelope`, `runUndoApply`, `@sprigr/apps-undo-journal` |

- `requireApproval(handlers, specs, opts)` wraps the named tools so each returns an `_approval` card instead of writing, then on the granted pass captures a before-image through the **pinned** connection and offers `_undo`. It resolves the connection inside itself, before the label lookup, the hash and the capture: a gate that sits outside the app's own pin names the wrong store, hashes the wrong store and captures the wrong store's copy. Register the result after the originals: `Object.assign(registry, requireApproval(registry, SPECS, opts))`.
- `dispatcherApproval(specs, opts)`: the same gate for a one-tool-many-actions dispatcher. Build it beside the action registry and call `gate.run(action, args, env, () => def.execute(state, parsed))` from the dispatcher; params are read from `opts.inputField` (default `input`), the action name is hashed in, and `pinEnv` may return a per-actor token state rather than the env.
- A spec with no `hash` binds the grant to its payload: every argument except the `keys` fields, the attestation flags and the gate's `connectionArgs` (e.g. `['store']`) goes into the hash canonically, so a tap on one payload cannot be spent on another (sprigr-apps#2605). See docs/write-protection.md.
- Every resolver on the gate is a **default, overridable per spec**: `ApprovalSpec.resolveConnection`, `.describeTarget` and `.stampConnection` win over the gate's for that spec alone. Reach for it when one app has two families of write that reach a connection differently (creates that POST under an account, deletes that address a global object id on a path carrying no account). One gate-level rule has to pick one of them, and for the other it prints a false connection on the card a person taps and mixes it into the grant hash. A spec that hits no connection returns `''`.
- `emailAudience({ to, cc, bcc, sender })` builds `_approval.audience` for a mail send (sprigr-team decision 0312): the lowercased, deduplicated recipients plus `sender: 'actor'` when the mail goes out through the actor's own connection. When every recipient is the person on the turn, the platform runs the send with no card. Set it from `ApprovalSpec.describe` only when the args name every recipient; a reply-all or a post into an existing chat must omit it. It returns undefined for an empty list, more than 50, or any entry that is not an address, so a partial list never stands for the whole (0.47.0)
- `approvalHash(rawId, connection, ...parts)`, `set(values)`, `seq(values)`: a stable operation identity so a tap survives the model reordering a list or dropping an optional argument on the retry.
- `undoEnvelope({...})` throws on a blank field. The platform drops the whole envelope on a blank and mints nothing, silently.
- `refuseWithoutForce(name, handler, opts)` / `archiveOfferRefusal(...)`: a delete refuses once and offers the vendor's native archive unless `force: true`.
- `buildConfirmationPolicy({ irreversible, always, rules })` declares a dispatcher's policy beside its action registry; `checkConfirmationPolicy({ policy, registry, ungated, requiredInput })` returns every silent failure (dead rule, `(unset)` placeholder, money threshold, unclassified write) for a one-line test.
- **Ask once when T1 and T2 both gate an action.** Pass `approval: { covered, conditional }` to `buildConfirmationPolicy` (or `deriveConfirmationPolicy`) and to `checkConfirmationPolicy`: `covered` is your approval spec keys (`Object.keys(APPROVAL_SPECS)`), `conditional` the covered actions your app sends through the gate only under a condition of its own (simpro's `GATE_ONLY_WHEN`), `[]` when there are none. Both are required. Each covered, unconditional, gated action gets `attended: 'approval_card'`, and the platform then skips the confirmation on a turn with a person on it, so the card is the only prompt; unattended runs still confirm. The builder never marks a conditional action, and the check fails a key that no spec covers or that sits on a conditional action (no prompt at all on a call that skips the card), a covered unconditional action without one (it asks twice), and a `conditional` entry with no spec. For flat `requireApproval` tools, run `attendedFindings(tool, rule, { covered, conditional })` over each tool-level rule. Needs a platform with sprigr-team decision 0167; an older one ignores the key and keeps asking twice.
- `runUndoApply(args, { env, journal, specs, pin })` is the body of your `internal: true` reverse tool: load, re-pin to the journalled connection, restore, drop. `pin` may hand `restore` a different type from the env (a per-actor token state), may throw (`connection_unavailable`) or return null to refuse (`connection_mismatch`); a restore that throws is `restore_failed` and the copy is kept; a successful restore may return `newId`, `notRestored`, `extra` (spread into the payload) and `note` (appended after the fidelity sentence).
- `safeCapture(scope, name, id, read)` and `offerUndo({ journal, entity, id, before, connection, fidelity, resource, describe, warning })`: the capture-then-offer halves for a write that is not behind an approval card (a dispatcher `update_*` action). `requireApproval` uses the same two on its granted pass.
- `sprigr-check-write-protection` (bin): every destructive-by-name tool or enumerated dispatcher action must carry a policy, or a reason in `apps/<app>/write-protection.json`; ratchets on `tools/write-protection-baseline.json`. It also refuses an `attended` key with any value other than `'approval_card'`, or on a rule that gates nothing (never baselined).

**Never offer `_undo` for money or messages.** Refunds, captures, cancellations, sent mail: the approval gate is the only control there.

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
- `resolveInstallBridge(env)` / `installTokenPost(bridge, path, body, opts?)` — build your own `/internal/wfp/*` fallback (collections, files, inbox) with the auth and error extraction handled.
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

## Webhook callback URLs

- `resolvePlatformWebhookBase(env)` / `buildMarketplaceWebhookUrl(env, installId, topicPath)` — env-correct platform host, so a staging install never registers prod-pointing subscriptions.

## Misc

- `fetchWithRetry` — rate-limit-header-aware, jittered retry
- `constantTimeEqual(a, b)` — bearer-secret verification
- `encodeState` / `decodeState` — OAuth state base64url
- `parseActor` / `actorKey` / `ownerFromActorKey` — per-actor token scoping
- `putAppFile` / `putAppFileStream` / `appFileUrl` / `getAppFile` / `listAppFiles` / `deleteAppFile` — durable app-scoped file storage from outside the injected bridge
- `fetchFileBytes` / `fetchFileAsBase64` / `bytesToBase64` / `base64ToBytes` — file byte helpers

Full platform semantics: [`docs/platform-reference.md`](../../docs/platform-reference.md).

## Write protection

Three platform tiers, and they are not substitutes for each other. Full guide: [`docs/write-protection.md`](../../docs/write-protection.md).

| Tier | Where | Who attests | Helper |
|---|---|---|---|
| T1 confirmation policy | manifest `tools[].confirmation` | the model (`confirm: true`) | `buildConfirmationPolicy` + `checkConfirmationPolicy`, `sprigr-check-write-protection` |
| T2 approval | handler returns `_approval` | a human tap | `requireApproval`, `approvalHash` / `set` / `seq` |
| T3 undo | handler returns `_undo`; manifest `undo.reverse_tool` | platform token | `requireApproval` (capture), `undoEnvelope`, `runUndoApply`, `@sprigr/apps-undo-journal` |

- `requireApproval(handlers, specs, opts)` wraps the named tools so each returns an `_approval` card instead of writing, then on the granted pass captures a before-image through the **pinned** connection and offers `_undo`. It resolves the connection inside itself, before the label lookup, the hash and the capture: a gate that sits outside the app's own pin names the wrong store, hashes the wrong store and captures the wrong store's copy. Register the result after the originals: `Object.assign(registry, requireApproval(registry, SPECS, opts))`.
- `dispatcherApproval(specs, opts)`: the same gate for a one-tool-many-actions dispatcher. Build it beside the action registry and call `gate.run(action, args, env, () => def.execute(state, parsed))` from the dispatcher; params are read from `opts.inputField` (default `input`), the action name is hashed in, and `pinEnv` may return a per-actor token state rather than the env.
- Every resolver on the gate is a **default, overridable per spec**: `ApprovalSpec.resolveConnection`, `.describeTarget` and `.stampConnection` win over the gate's for that spec alone. Reach for it when one app has two families of write that reach a connection differently (creates that POST under an account, deletes that address a global object id on a path carrying no account). One gate-level rule has to pick one of them, and for the other it prints a false connection on the card a person taps and mixes it into the grant hash. A spec that hits no connection returns `''`.
- `approvalHash(rawId, connection, ...parts)`, `set(values)`, `seq(values)`: a stable operation identity so a tap survives the model reordering a list or dropping an optional argument on the retry.
- `undoEnvelope({...})` throws on a blank field. The platform drops the whole envelope on a blank and mints nothing, silently.
- `refuseWithoutForce(name, handler, opts)` / `archiveOfferRefusal(...)`: a delete refuses once and offers the vendor's native archive unless `force: true`.
- `buildConfirmationPolicy({ irreversible, always, rules })` declares a dispatcher's policy beside its action registry; `checkConfirmationPolicy({ policy, registry, ungated, requiredInput })` returns every silent failure (dead rule, `(unset)` placeholder, money threshold, unclassified write) for a one-line test.
- `runUndoApply(args, { env, journal, specs, pin })` is the body of your `internal: true` reverse tool: load, re-pin to the journalled connection, restore, drop. `pin` may hand `restore` a different type from the env (a per-actor token state), may throw (`connection_unavailable`) or return null to refuse (`connection_mismatch`); a restore that throws is `restore_failed` and the copy is kept; a successful restore may return `newId`, `notRestored`, `extra` (spread into the payload) and `note` (appended after the fidelity sentence).
- `safeCapture(scope, name, id, read)` and `offerUndo({ journal, entity, id, before, connection, fidelity, resource, describe, warning })`: the capture-then-offer halves for a write that is not behind an approval card (a dispatcher `update_*` action). `requireApproval` uses the same two on its granted pass.
- `sprigr-check-write-protection` (bin): every destructive-by-name tool or enumerated dispatcher action must carry a policy, or a reason in `apps/<app>/write-protection.json`; ratchets on `tools/write-protection-baseline.json`.

**Never offer `_undo` for money or messages.** Refunds, captures, cancellations, sent mail: the approval gate is the only control there.

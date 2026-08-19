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

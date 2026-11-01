# `sprigr-app.json` reference

Every Sprigr app has one manifest, `sprigr-app.json`, at the root of the app directory (next to `package.json`). It is plain JSON: no comments and no trailing commas. The annotated example at the end uses JSONC comments only to explain it; strip them before you publish.

This page lists every top-level field the platform knows about. For how to build an app around the manifest, start with [marketplace-app-development.md](../marketplace-app-development.md).

## How the manifest is checked

The platform runs one validator over the manifest at publish, and the same validator answers the dry-run endpoint `POST /api/v1/data/marketplace/apps/validate`. Know these behaviours before you rely on it:

- **Only the first error comes back.** The validator stops at the first problem it finds. Fix it and run again; there may be more.
- **Unknown keys are ignored.** A misspelt field such as `"effect": "write"` instead of `"effects": "write"` is not an error. It does nothing, silently. Check spelling against this page. The one exception is `trust_tier`, which is refused (see [Trust tier](#trust-tier-is-not-a-manifest-field)).
- **Most warnings are not shown to you.** Warnings about `effects` values, platform-only tools that lack `internal: true`, and actor-scoped storage go to the platform's own logs. Only two warnings come back in the publish response (`warnings` array): a legacy scope that grants nothing, and a docs entry that uses the deprecated `_keywords` key. The validate endpoint returns only the scope warning.
- **The dry run is not a publish.** The validate endpoint reads nothing from the registry. It always applies the reserved-slug check and never the checks that compare against your previous version. It does not look at uploaded files, so it cannot check the icon, Home fixtures, doc file contents, migration files or the lockfile, and it cannot check that an inbox channel or interface is free.
- **`sprigr app validate` is only complete when you are logged in.** With an API key and endpoint configured, it calls the server and prints `Manifest OK (live server check, not a publish guarantee)`. Offline it prints `(offline, partial)` and runs a local subset: required metadata, `home`, `runtime.tier`, `cross_tenant_tools`, `app_dependencies`, `migrations`, `docs`, `secrets`, `webhooks`, `schedules` (without checking that the tool exists), `agent_schedules`, `metadata.agent_routing`, `metadata.document_capabilities`, `oauth.inbound_install`, `events` and agent notes. Offline it does not check `tools[]`, `runtime.entry`, scopes, reserved slugs, storage prefixes, data indexes, datasets, interfaces, channels, jobs or decision points.

At publish, after the validator passes, the platform also checks:

1. Home fixtures and the icon file.
2. That no other app owns your inbox channels, and that interface changes are allowed.
3. That every `migrations[].file` is in the upload: `Manifest references migration file "X" but it is not in the upload`.
4. That every `docs[].file` is in the upload, parses and validates: `Manifest references docs file "X" but it is not in the upload`, `docs file "X" is not valid JSON`, `docs objectID "X" is duplicated across docs files`.
5. File size limits, then the lockfile: a version with dependencies and no lockfile is refused.
6. That the slug is not owned by another publisher: 409 `Slug already taken by a different publisher`.
7. The version rule in [Versions and republishing](#versions-and-republishing).

## Field summary

| Field | Required | Section |
|---|---|---|
| `sprigr_app`, `metadata`, `kind`, `runtime`, `permissions` | `sprigr_app`, `metadata`, `runtime`*, `permissions`* | [Identity and runtime](#identity-and-runtime) |
| `secrets` | no | [Secrets](#secrets) |
| `tools` | yes* | [Tools](#tools) |
| `schedules`, `jobs`, `agent_schedules` | no | [Background work](#background-work) |
| `webhooks`, `channels`, `events` | no | [Inbound traffic and events](#inbound-traffic-and-events) |
| `cross_tenant_tools`, `interfaces`, `app_dependencies`, `integration_dependencies`, `dependencies`, `fulfillment_services` | no | [App to app](#app-to-app) |
| `internal_storage_prefixes`, `actor_scoped_storage_prefixes`, `data_index`, `data_indexes`, `data_exports`, `datasets`, `migrations`, `data_lifecycle` | no | [Storage and data](#storage-and-data) |
| `docs`, `home`, `undo`, `tool_access`, `content_restrictions`, `config_schema`, `decision_points`, `workflow_templates` | no | [Agent and portal surface](#agent-and-portal-surface) |
| `auth`, `capabilities`, `oauth`, `lifecycle` | no | [Auth and capabilities](#auth-and-capabilities) |
| `agent_config`, `training_index` | for `kind: "agent"` | [Agent templates](#agent-templates) |

\* Not required when `kind` is `"agent"`.

## Identity and runtime

### `sprigr_app`

- Type: object `{ "version": string }`. Required.
- Only presence of `version` is checked. Use `"1"`.
- Error: `Missing sprigr_app.version`.

```json
"sprigr_app": { "version": "1" }
```

### `metadata`

Required object. The listing is re-synced from it on every publish, so a field you drop disappears from the listing.

| Key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | `Missing metadata.name` |
| `slug` | string | yes | `Missing metadata.slug`. Use lowercase words joined by single hyphens (`acme-crm`). See below. |
| `version` | string | yes | `Missing metadata.version`. Semver. See [Versions and republishing](#versions-and-republishing). |
| `description` | string | yes | `Missing metadata.description` |
| `author` | `{ name, email?, url? }` | yes | `Missing metadata.author.name` |
| `icon` | string | no | See below. |
| `category` | string | no | Not validated. |
| `tags` | string[] | no | Not validated. |
| `agent_routing` | string | no | See below. |
| `document_capabilities` | object | no | See below. |

**Slug.** Publish applies no format pattern to a new slug, but `app_dependencies` only accepts slugs matching `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, and tool names, inbox channels and the OAuth callback are derived from the slug, so use that shape. These slugs are refused for a new app: `sprigr`; the built-in integration types `gmail`, `outlook_mail`, `outlook_calendar`, `google_calendar`, `archibus`, `gdrive` and `onedrive`; and any slug that would put `-acl-` into the app's index names. The slug is the app's identity: publishing under a new slug creates a different app.

**Icon.** A path to an `.svg` or `.png` file in the upload, or a `data:image/svg+xml;base64,...` or `data:image/png;base64,...` URI. An SVG is at most 32 KiB, must start with `<svg`, and needs a `viewBox` or `width` and `height`. Scripts, `foreignObject`, `iframe`, `embed`, `object`, `link`, `meta`, `on*` handlers, `javascript:`, `@import`, external `href` or `url()` references and `DOCTYPE` or `ENTITY` declarations are refused. A PNG must be square, 64 to 1024 px, at most 64 KiB. Errors include `metadata.icon references "X" but it is not in the uploaded files` and `metadata.icon "X" must be an .svg or .png file`.

**Tags.** Free text for search. The `first-party` tag only has an effect on apps published by Sprigr itself.

**`agent_routing`.** One plain sentence, at most 300 characters after trimming, telling agents which of your tools answer which requests. It may only name tools this manifest declares, and may not contain a URL, domain, IP address, email address, line break, backtick, `< > { }`, call syntax or invisible characters. Example error: `metadata.agent_routing names "X", which is not a tool this app declares in tools[]; a routing line may only name the app's own tools`. Guidance: [Telling agents which of your tools to use](../marketplace-app-development.md#telling-agents-which-of-your-tools-to-use-metadataagent_routing).

**`document_capabilities`.** For apps that store documents. `storage_label` is required (a plain name of at most 40 characters, not "Sprigr"), plus at least one of `create`, `edit`, `convert`, `read`, `transcribe`, `ocr`, `preview`, `thumbnail`. Each names a tool you declare that is not `internal`.

```json
"metadata": {
  "name": "Acme CRM",
  "slug": "acme-crm",
  "version": "0.1.0",
  "description": "Read and update Acme CRM contacts from agent chat.",
  "author": { "name": "Example Pty Ltd", "email": "dev@example.com" },
  "category": "crm",
  "tags": ["crm", "contacts"],
  "agent_routing": "Use acme_crm for anything about Acme CRM contacts or deals."
}
```

### Trust tier is not a manifest field

`trust_tier` is not part of the manifest, and a manifest that declares it is refused at publish. An app's tier comes from how it is distributed: listing it, sharing it with specific companies, or Sprigr's review. See [scopes-and-trust.md](scopes-and-trust.md).

### `kind`

- Type: `"tool"` (default), `"integration"` or `"agent"`. Optional.
- `tool` and `integration` validate the same way. The difference is in the portal: after installing an `integration`, the user is taken to its configure page to connect an account.
- `agent` publishes an agent template. It needs only `agent_config.persona` (`Agent templates require agent_config.persona`) and skips the checks on `runtime`, `permissions` and `tools`. `home` and `data_lifecycle` are still checked, and `data_lifecycle.system_of_record` is refused on an agent.

```json
"kind": "integration"
```

### `runtime`

| Key | Type | Required | Notes |
|---|---|---|---|
| `entry` | string | yes (non-agent) | `Missing runtime.entry` |
| `tier` | `"ssr"` or `"static"` | no, default `"ssr"` | Any other value is refused. |
| `framework` | `"next"`, `"astro"`, `"remix"` or `"static"` | no | Not validated, but set it. An `ssr` app without a framework is built as static and fails at build time, not at publish. |

```json
"runtime": { "entry": "src/app/page.tsx", "tier": "ssr", "framework": "next" }
```

### `permissions`

| Key | Type | Required | Notes |
|---|---|---|---|
| `scopes` | string[] | yes (non-agent) | `Missing permissions.scopes`. Must include `tools:register`: `tools:register scope is required`. |
| `network_domains` | string[] | no | Hosts your app calls. Each entry must be at least 3 characters: `Invalid network domain: "X"`. Calls to undeclared hosts are logged today and will be refused in a later release. |

Scope errors: `permissions.scopes: "X" is not a platform scope. Known scopes: ...` and `permissions.scopes entries must be strings`.

```json
"permissions": {
  "scopes": ["tools:register", "sprigr.jobs"],
  "network_domains": ["api.acme.example"]
}
```

#### Scopes

| Scope | What it grants |
|---|---|
| `tools:register` | Required on every non-agent app. Lets the app's tools be registered with agents. |
| `knowledge:read` | Accepted. No runtime surface reads it today. |
| `knowledge:write` | Accepted. No runtime surface reads it today. |
| `inbox:write` | `env.SPRIGR.inbox.append` and the inbox surfaces. |
| `sprigr.browser:fetch` | `env.SPRIGR.browser.fetch` and `screenshot`. |
| `sprigr.jobs` | Durable jobs (`env.SPRIGR.jobs`) and the company-scoped store (`env.SPRIGR.store`). |
| `sprigr.jobs:publisher` | The publisher-scoped store. Needs `sprigr.jobs`. |
| `sprigr.browser:session` | `env.SPRIGR.browser.session`. Works only on an install owned by the publisher's own company (others get 403 `not_publisher_owner`). Needs `sprigr.jobs` and `sprigr.jobs:publisher`. |
| `teams:read` | `env.SPRIGR.teams`. |

Three legacy scopes are still accepted but grant nothing: `sprigr.data:write`, `sprigr.data:read` and `sprigr.knowledge:write`. Publishing with one returns this warning: `permissions.scopes: "<scope>" grants nothing and a later release will refuse it. Remove it from the manifest.` Remove them.

Runtime calls are checked against the scopes an install was granted. A scope added in a new version is granted to existing auto-upgrading installs on upgrade, without asking the user again.

## Secrets

`secrets` is an optional array of per-install values the platform stores encrypted and passes to your app as environment bindings.

| Key | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | `^[A-Z][A-Z0-9_]*$`, unique. |
| `label` | string | yes | `secrets entry "X" missing label` |
| `type` | `"secret"` or `"text"` | yes | `secrets entry "X" has invalid type "Y"` |
| `required` | boolean | yes | `secrets entry "X" must specify required: boolean` |
| `description` | string | no | Shown on the configure form. |
| `publisher_provides` | boolean | no | You supply the value once for every install (OAuth client id and secret). Set it with `sprigr app set-publisher-secrets`. If a required one is missing, install fails with `platform_misconfigured`. |
| `auto_generate` | boolean | no | The platform mints a random 32-byte value per install, once. Use it for encryption keys. |

`publisher_provides` and `auto_generate` cannot both be set (`secrets entry "X" cannot set both publisher_provides and auto_generate (...)`). A key that is not upper snake case is refused with an error naming the key.

```json
"secrets": [
  { "key": "ACME_CRM_TOKEN_KEK", "label": "Token encryption key", "type": "secret", "required": true, "auto_generate": true },
  { "key": "ACME_CRM_CLIENT_ID", "label": "OAuth client id", "type": "secret", "required": true, "publisher_provides": true }
]
```

## Tools

`tools` is required for non-agent apps (`At least one tool is required`). Each entry is one tool the platform can dispatch to your app. A handler file default-exports an object keyed by tool name.

| Key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | `^[a-z][a-z0-9_]*$`. Errors: `Tool missing name`, `Tool "X" has invalid name (use lowercase, underscores, start with letter)`. |
| `description` | string | yes | `Tool "X" missing description`. Agents choose tools by this text. |
| `handler` | string | yes | Path to the handler file. `Tool "X" missing handler`. |
| `input_schema` | object | yes | See below. `Tool "X" missing input_schema`. |
| `output_schema` | object | no | Not validated. |
| `internal` | boolean | no | `true` hides the tool from agents; only the platform calls it. `Tool "X" internal must be a boolean`. |
| `effects` | `"write"` or `"read"` | no | Overrides the name-based guess of whether the tool changes state. Other values are ignored with a log-only warning. See [Declaring a tool's side effects](../marketplace-app-development.md#declaring-a-tools-side-effects-toolseffects). |
| `confirmation_required` | boolean | no | Shorthand for `"confirmation": { "always": true }`. |
| `confirmation` | object | no | See below. |
| `idempotency` | object | no | See below. |
| `dispatch` | object | no | See below. |

**`input_schema`.** A JSON Schema object (`Tool "X" input_schema must be a JSON Schema object, got <type>`). If it has no `type`, the platform adds `"type": "object"`. The top level may not be a `oneOf`, `anyOf` or `allOf` union; use one object with an `action` property instead. The top-level property names `actor`, `caller`, `_home` and `_write_key` are reserved because the platform adds them to every call; declaring one is refused (`Tool "X" input_schema.properties must not declare "actor": ...`). The same names nested deeper are fine.

**`confirmation`.** Asks a person before the call runs. Set `always: true`, a `when` condition, or an `actions` map of per-action rules keyed by the value of the action argument (`dispatch.actionField`, default `action`) (`Tool "X" confirmation must set always, when, or actions`). Other keys: `describe`, `irreversible`, `attended`. `when` is one condition or an array of conditions. A condition is one of `{ "count": "<field>", "atLeast": n }` (positive integer) or `{ "field": "<name>" }` with exactly one of `equals`, `notEquals`, `in` or `any`, and `any` may nest one level. `attended` is not validated. Full rules: [write-protection.md](../write-protection.md#t1-declare-the-policy-beside-the-code).

**`idempotency`.** `{ "mode": "content" | "request", "actionField"?, "actions"? }`. Not validated. `request` mode passes a retry key in `args._write_key`. See [Idempotent writes](../write-protection.md#idempotent-writes-answering-the-agents-retry).

**`dispatch`.** For one tool that exposes many actions: `actionField`, `actions`, `writeActions`, `actionInputs` (`{ accepts, required }` per action) and `actionDescriptions`. Only `writeActions` is validated, and only against `actions`: `Tool "X" dispatch.writeActions needs dispatch.actions, the catalogue its entries are checked against`, `Tool "X" dispatch.writeActions names "Y", which is not in dispatch.actions. ...`. See [Dispatcher tools](../write-protection.md#dispatcher-tools).

**Platform-only tools.** Some tools are entry points only the platform calls. Mark each one `internal: true`. The platform keeps them away from agents either way, but without the flag it logs a warning you will not see. They are:

- your OAuth callback, which must be named `<slug with - replaced by _>_oauth_callback` (`acme_crm_oauth_callback`);
- tools named by `webhooks[].handler_tool`, `jobs[].tool`, `events.subscribes[].handler_tool`, `undo.reverse_tool`, `oauth.inbound_install.import_tool`, `home.tool`, and the inbox `send.tool` and `attachment_repair_tool`;
- lifecycle hooks, matched by exact name: `on_install`, `on_upgrade`, `on_uninstall`, `on_actor_retired`. See [Lifecycle hooks](../marketplace-app-development.md#lifecycle-hooks-on_install-on_upgrade-on_uninstall).

```json
"tools": [
  {
    "name": "acme_crm",
    "description": "Acme CRM. Actions: search_contacts, update_contact.",
    "handler": "src/handlers/acme-crm.ts",
    "effects": "write",
    "input_schema": {
      "type": "object",
      "properties": { "action": { "type": "string", "enum": ["search_contacts", "update_contact"] } },
      "required": ["action"]
    }
  }
]
```

**App-prefixed tool names.** Several fields only accept a tool name with at least one underscore, matching `^[a-z][a-z0-9]*(_[a-z0-9]+)+$`: `schedules[].tool`, `webhooks[].handler_tool`, `events.subscribes[].handler_tool`, `cross_tenant_tools[].tool_name`, the `tools` lists in `app_dependencies` and `integration_dependencies`, and `oauth.inbound_install.import_tool`. Start every tool name with your app's name and you will not hit this.

## Background work

### `schedules`

Cron jobs that call one of your tools per install. Rows are created at install and are active from then on.

| Key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | `^[a-z][a-z0-9_]*$`, unique. |
| `cron` | string | yes | Five fields: `schedules entry "X" cron must have 5 whitespace-separated fields, got N`. Each field is parsed. |
| `tool` | string | yes | App-prefixed, declared in `tools[]`, with a handler. Errors: `schedules entry "X" tool "Y" does not match any declared tool in tools[]`, `schedules entry "X" tool "Y" has no handler ...`. |
| `timezone` | string | no | Default `UTC`. Only the type is checked. |
| `scope` | `"per_install"` or `"per_tenant"` | no, default `"per_install"` | `schedules entry "X" has invalid scope "Y"` |

```json
"schedules": [
  { "name": "refresh_tokens", "cron": "*/45 * * * *", "tool": "acme_crm_refresh_tokens", "scope": "per_install" }
]
```

### `jobs`

Durable multi-step jobs. At most 20. Needs the `sprigr.jobs` scope, which is checked when the job runs, not at publish.

| Key | Type | Default | Limits |
|---|---|---|---|
| `name` | string | required | snake case |
| `tool` | string | required | declared in `tools[]`; make it `internal` |
| `description` | string | none | |
| `timeout_minutes` | integer | 60 | 1 to 10080 |
| `step_timeout_seconds` | integer | 60 | 5 to 270 |
| `max_steps` | integer | 200 | 1 to 450 |
| `retries.limit` | integer | 3 | 0 to 10 |
| `retries.delay_seconds` | integer | 10 | 1 to 3600 |
| `retries.backoff` | string | `"exponential"` | `constant`, `linear`, `exponential` |

```json
"jobs": [{ "name": "full_sync", "tool": "acme_crm_full_sync", "timeout_minutes": 120 }]
```

The step contract and the store: [section 2c](../marketplace-app-development.md#2c-durable-jobs--the-scoped-store).

### `agent_schedules`

Schedules created on the installing company's agents at install: `{ name, cron, prompt, agentSlug?, taskType?, timezone?, enabled? }`. `taskType` is `message` (default), `reminder`, `pipe` or `script`; `prompt` is required for `message`.

```json
"agent_schedules": [{ "name": "weekly_digest", "cron": "0 8 * * 1", "prompt": "Summarise last week's Acme CRM changes." }]
```

## Inbound traffic and events

### `webhooks`

Each entry gets the URL `https://webhooks.sprigr.com/webhook/marketplace/{install_id}/{path}`.

| Key | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | `^\/[a-zA-Z0-9_\-/]+$`, unique. |
| `handler_tool` | string | yes | App-prefixed tool. |
| `signature` | object | yes | See below. |
| `forward_headers` | string[] | no | Request headers passed to the handler. |
| `delivery` | `"immediate"` or `"batch"` | no | |
| `delivery_id_header` | string | no | Header that identifies a redelivery. |
| `batch` | `{ coalesce_key, coalesce_order, max_deliveries }` | no | Only with `delivery: "batch"`. `max_deliveries` 1 to 100. Not with `respond_with_outcome` or `shared`. |
| `respond_with_outcome` | boolean | no | Only with `install_token` signatures. |
| `shared` | object | no | One URL for the whole app. Needs an `hmac` signature, an `encoding` and a `publisher_provides` secret. See [Shared webhooks](../marketplace-app-development.md#shared-webhooks-one-delivery-url-for-the-whole-app-webhooksshared). |

`signature.type` is `hmac` (default), `install_token`, `google_oidc` or `handshake_hmac`. `header` is always required. `hmac` and `handshake_hmac` need `algorithm` (`sha256` or `sha1`); other types must not set it. `hmac` needs `secret_ref` naming a declared secret; other types must not set it. `encoding` is `hex` or `base64`. `handshake` (`{ header, key_query }`) is only for `handshake_hmac`. `google_oidc` requires `header: "Authorization"` and allows `oidc_email`.

```json
"webhooks": [{
  "path": "/contact-updated",
  "handler_tool": "acme_crm_on_contact_updated",
  "signature": { "type": "hmac", "header": "X-Acme-Signature", "algorithm": "sha256", "secret_ref": "ACME_CRM_WEBHOOK_SECRET", "encoding": "hex" }
}]
```

### `channels`

Messaging channels the app adds (for example a chat network agents can reply on).

| Key | Notes |
|---|---|
| `type` | `^[a-z][a-z0-9_]*$`, unique, not a built-in channel name. |
| `display_name` | Shown in the portal. |
| `inbound` | `{ receive_tool, shared?, external_id_path? }`. `external_id_path` is required when `shared` is true. |
| `outbound` | `{ send_tool }` |
| `identity_tool` | optional |
| `supports` | `{ notify?, interactive?, threads? }` |

Every tool named here must be in `tools[]`.

```json
"channels": [{ "type": "acme_chat", "display_name": "Acme Chat", "inbound": { "receive_tool": "acme_crm_receive" }, "outbound": { "send_tool": "acme_crm_send" } }]
```

### `events`

Typed events your app emits and subscribes to. Your app can only emit events it declares.

- `emits[]`: `{ name, schema, description?, partition_field?, scope? }`. `name` matches `^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$` and is unique, so the first segment has no underscore (`acmecrm.contact.updated`). `schema` is an object. `partition_field` must be a property in `schema`. `scope` is `per_install` or `per_tenant`.
- `subscribes[]`: `{ event, handler_tool, filter? }`. `handler_tool` is app-prefixed. No duplicate event and handler pair.
- `cross_tenant_emits[]`: `{ event, description? }`. `event` must be in `emits`.

```json
"events": {
  "emits": [{ "name": "acmecrm.contact.updated", "schema": { "type": "object", "properties": { "id": { "type": "string" } } } }]
}
```

## App to app

### `cross_tenant_tools`

Tools another company can be granted access to. Install creates one grant per entry.

| Key | Notes |
|---|---|
| `tool_name` | App-prefixed, unique. Declare the tool in `tools[]` as well. |
| `resource_type` | What the grant covers. |
| `description` | Shown on the grant. |
| `input_schema` | Required. Schema for callers. |
| `output_schema` | Optional. |
| `action` | `read`, `write` or `act`. Informational. |
| `provides` | `{ interface, op, version? }`, where `interface` is `<owner_slug>/<name>`. The tool implements an op of an interface you publish. Needs the `<slug with _>_` name prefix, a declared tool, and an op that the interface declares. |

A platform-only tool cannot be exposed: `cross_tenant_tools: "X" is a platform-only entry point (role); another app must not be able to call it. Expose a separate tool for cross-tenant callers.`

```json
"cross_tenant_tools": [{ "tool_name": "acme_crm_lookup", "resource_type": "contact", "description": "Look up a contact by email.", "action": "read", "input_schema": { "type": "object" } }]
```

### `interfaces`

Versioned contracts other apps can depend on. Each is published under the id `<slug>/<name>`, and a published version is immutable.

- `name`: snake case. `version`: `MAJOR.MINOR.PATCH`. `consumers`: `owner`, `same_publisher` (default) or `any`.
- `ops[]`: `{ name, description, input_schema, output_schema?, effects? }`. `input_schema` is required; `effects` is `read` or `write`.
- `events[]` and `records[]` describe events and record shapes.

Worked example: [interfaces/fulfilment-hub-v1.md](../interfaces/fulfilment-hub-v1.md).

```json
"interfaces": [{ "name": "contacts", "version": "1.0.0", "ops": [{ "name": "lookup", "description": "Find a contact", "input_schema": { "type": "object" } }] }]
```

### `app_dependencies`

Tools your app calls on another app installed in the same company.

- `app`: a slug, or `{ "provides": "<slug>/<interface>", "version": "^1" }` (`^1`, `^1.2`, `^1.2.3` or an exact version).
- `tools`: non-empty list of tool names on that app. In the interface form, the interface ops you call.
- `required`: boolean. A required dependency that is not installed blocks install.
- `reason`: shown to the installer.

```json
"app_dependencies": [{ "app": "acme-billing", "tools": ["acme_billing_get_invoice"], "required": false, "reason": "Shows invoice status on contacts." }]
```

### `integration_dependencies`

Tools your app calls on a built-in integration the company has connected. `integration_type` is one of `gmail`, `outlook_mail`, `outlook_calendar`, `google_calendar`, `simpro`, `gorgias`, `github`, `xero`, `archibus`, `gdrive`, `onedrive`, `shopify`. Other keys as in `app_dependencies`.

```json
"integration_dependencies": [{ "integration_type": "shopify", "tools": ["shopify_get_order"], "required": true }]
```

### `dependencies`

Slug-level install gate: `{ "required"?: [{ slug, reason }], "optional"?: [...] }`. Not validated at publish. Install is refused when a required slug is not installed. It grants no tool access; use `app_dependencies` for that.

```json
"dependencies": { "required": [{ "slug": "acme-billing", "reason": "Invoices live there." }] }
```

### `fulfillment_services`

Fulfilment services the app registers. Not validated at publish. Declaring it adds a consent checkbox to the install dialog. See [interfaces/fulfilment-hub-v1.md](../interfaces/fulfilment-hub-v1.md).

## Storage and data

### `internal_storage_prefixes` and `actor_scoped_storage_prefixes`

Both are arrays of file-storage path prefixes: at most 32 entries, each at most 200 characters, relative (no leading `/`), ending in `/`, no duplicates. `actor_scoped_storage_prefixes` also refuses a prefix nested inside another listed prefix.

- Internal prefixes are hidden from agent file tools and file links, even for the company that owns the files.
- Actor-scoped prefixes are stored per verified caller, so one person cannot read another's files there. An app with `auth.model: "per_actor"` and no actor-scoped prefixes gets a log-only warning.

The two lists may overlap.

```json
"internal_storage_prefixes": ["cache/"],
"actor_scoped_storage_prefixes": ["drafts/"]
```

### `data_index`

One search index for the app: `{ searchable_attributes?, attributes_for_faceting?, description?, acl_patchable_fields? }`. Not validated, except that it cannot be combined with `data_indexes` and that `acl_patchable_fields` has at most 32 entries and never names `objectID`, `acl_principals` or `content`.

```json
"data_index": { "searchable_attributes": ["name", "email"], "attributes_for_faceting": ["status"] }
```

### `data_indexes`

Several named search indexes. At most 24. Keys match `^[a-z][a-z0-9_]{0,31}$` and may not start with `acl`.

| Key | Notes |
|---|---|
| `searchable_attributes` | Required, non-empty. |
| `attributes_for_faceting`, `description` | Optional. |
| `shard_by` | `none`, `year`, `month` or `hash`. |
| `shard_field` | Required when sharded. Not `updated_at`. |
| `shard_buckets` | 2 to 64, `hash` only. |
| `dataset` | Must name a declared dataset. |
| `access` | `analytics_roles` only. Not allowed on an index named `files`. |
| `contract_version`, `record_grain`, `fields` | Data contract, as in `datasets`. Put them directly on the entry; a nested `contract` object is refused. |
| `agent_notes` | A string, or up to 12 strings. Each at most 500 characters, 2000 in total. |

`acl_patchable_fields` is not supported here: `data_indexes.X.acl_patchable_fields is not supported: withAcl writes exist only for an app with a single data_index`.

Field types in a contract: `string`, `number`, `date`, `boolean`. Sensitivity tags: `pii`, `financial_cost`, `contact`, `free_text`. Join hints: `order_ref`, `sku`, `email`, `date`, `product_ref`, `customer_ref`, `collection_ref`, `abn`, `invoice_ref`, `job_ref`. A field `note` is at most 200 characters.

```json
"data_indexes": {
  "contacts": { "searchable_attributes": ["name", "email"], "shard_by": "none" }
}
```

### `data_exports`

Named exports that run one of your tools. At most 24, same key rule as `data_indexes`. Each entry: `tool` (declared), `args?`, `description?`, `contract_version: 1` (required), `record_grain?`, `fields` (required), `agent_notes?`. If any field is tagged `pii`, `financial_cost` or `contact`, the tool must be `internal`.

```json
"data_exports": {
  "contacts": { "tool": "acme_crm_export_contacts", "contract_version": 1, "fields": { "email": { "type": "string", "sensitivity": "contact" } } }
}
```

### `datasets`

Bulk tables written with `env.SPRIGR.datasets.append`. Agents never read datasets. 1 to 512 entries, same key rule.

| Key | Notes |
|---|---|
| `mode` | `append` (default), `keyed` or `snapshot`. Fixed once published. |
| `contract_version` | Required. `1`. |
| `fields` | Required. The names `company_id`, `install_id`, `app_slug`, `dataset`, `ingested_at` and `run_id` are reserved. |
| `partition_key` | Required for `append`; must end in a `date` field. |
| `key` | Required for `keyed`. Fields with no sensitivity tag. Fixed once published. |
| `version_field` | Optional for `keyed`. A `date` or `number` field. Fixed once published. |
| `retention_days` | 1 to 3650. |

```json
"datasets": {
  "orders": { "mode": "append", "contract_version": 1, "partition_key": ["order_date"],
    "fields": { "order_date": { "type": "date" }, "total": { "type": "number", "sensitivity": "financial_cost" } } }
}
```

### `migrations`

SQL files applied to the install's own database after upload and before the build reports success. A failing migration fails the build.

- `file`: `migrations/<name>.sql`. Anything else is refused with an error naming the file.
- `version`: non-negative integer, unique (`... duplicates version N`).
- `description`: optional.

```json
"migrations": [{ "file": "migrations/0001_init.sql", "version": 1, "description": "Initial schema" }]
```

### `data_lifecycle`

`{ "system_of_record": boolean }`. No other keys. Set it when your app is where the company's data lives, not a copy of another system. Uninstall then requires an export or the owner's explicit waiver, and data purge is held. Once a version publishes `true`, a later version cannot drop it.

Errors: `data_lifecycle must be an object, e.g. { "system_of_record": true }`, `unknown data_lifecycle field "X" (allowed: system_of_record)`, `data_lifecycle.system_of_record must be a boolean`.

```json
"data_lifecycle": { "system_of_record": true }
```

## Agent and portal surface

### `docs`

AI-facing guides seeded for agents. At most 20 files, each `docs/<name>.json` and unique. Each file is a JSON array of objects: `objectID` (`^[a-z0-9][a-z0-9_-]*$`, unique across all files), `title` and `content` (required, at most 4000 characters), `category` (`guide`, `reference` or `entity`) and `keywords` (string). At most 100 objects per app. `_keywords` is deprecated and returns a publish warning. The validator checks the declaration; file contents are checked at publish. See [section 2b](../marketplace-app-development.md#2b-shipping-ai-facing-docs-docs).

```json
"docs": [{ "file": "docs/tools.json" }]
```

### `home`

Feeds the Sprigr Home: `{ tool, links?, identity?, rate?, provides }`. Validated at publish, including its fixture files. The shape, with a worked example, is in [home-contracts.md](../home-contracts.md); the normative rules are in [interfaces/sprigr-home-v1.md](../interfaces/sprigr-home-v1.md).

### `undo`

`{ "reverse_tool": "<tool>" }`. Declaring it gives agents `undo_change` and `list_undoable_changes` for your writes. Make the reverse tool `internal`; this is not validated. See [T3: the reverse tool](../write-protection.md#t3-the-reverse-tool).

```json
"undo": { "reverse_tool": "acme_crm_reverse" }
```

### `tool_access`

`{ "allowed_channels"?: string[], "default_agent_scope"?: "private" | "shared" }`. Not validated. Copied to the install; the default channels are `webchat`, `internal` and `website`.

```json
"tool_access": { "allowed_channels": ["webchat", "internal"], "default_agent_scope": "shared" }
```

### `content_restrictions`

`{ "rules"?: string[], "summary"?: string }`. Not validated. Added to the prompt of agents that use the app.

```json
"content_restrictions": { "summary": "Never share contact phone numbers outside the company." }
```

### `config_schema`

Not validated, and nothing on the platform reads it today. Per-install settings come from the install's configuration and from `secrets`. Do not rely on this field.

### `decision_points`

Named points where a workflow can ask for a decision. `id` matches `^[a-z][a-z0-9_]{1,63}$` and is unique; `description` is required; `input_schema`, `output_schema` and `default_behavior` are optional. Validated at publish; no platform feature reads it yet.

```json
"decision_points": [{ "id": "approve_discount", "description": "Approve a discount above 10%." }]
```

### `workflow_templates`

Workflows offered to the installing company: `{ slug, name, description?, trigger_type, trigger_config?, start_step_id, steps, tags? }`. `trigger_type` is `manual`, `event`, `schedule` or `webhook`. Not validated at publish; templates are checked when installed.

```json
"workflow_templates": [{ "slug": "new-contact-welcome", "name": "Welcome new contacts", "trigger_type": "manual", "start_step_id": "s1", "steps": [] }]
```

## Auth and capabilities

### `auth`

Only `auth.model` is validated: `"per_actor"` (each person connects their own account) or `"install_wide"` (one connection for the company). Omit it for `install_wide`. Error: `auth.model has invalid value ..., must be one of per_actor, install_wide. Omit it to mean install_wide.` `auth.type`, `auth.scopes` and the URL fields are not read. `auth.fields` is still merged into the configure form; use `secrets` instead.

```json
"auth": { "model": "per_actor" }
```

### `capabilities`

- `personal_mailbox`: boolean. Declares that each install reads one person's own mailbox, so the platform scopes it to that person's agents. Not for shared team inboxes.
- `inbox_channels`: 1 to 8 inbox channels for mail and ticket apps. Each `channel` must start with `<slug with _>_` and must not belong to another app. A `deep_link_template` host must be in `network_domains`. Full shape: [section 6c](../marketplace-app-development.md#6c-mail-and-ticket-apps-the-inbox-contract).

```json
"capabilities": { "personal_mailbox": true }
```

### `oauth`

`{ provider?, scopes?, inbound_install? }`. `provider` is not read. `scopes` is used only by `inbound_install`. For the ordinary OAuth flow you need none of this; see [section 6](../marketplace-app-development.md#6-oauth---the-shared-bouncer-pattern).

`inbound_install` lets a provider's own app store start an install:

- `signature_scheme`: `shopify_hmac` or `none`.
- `authorize_url_template`, `token_url_template`: `https` URLs. Placeholders must be listed in `entry_params`. A templated host requires a matching `network_domains` entry.
- `token_style`: `oauth2_authorization_code`. `scope_delimiter`: 1 to 3 characters.
- `entry_params`: lowercase snake names. `external_id_param` must be one of them.
- `oauth.scopes` must be non-empty.
- `import_tool`: app-prefixed and declared in `tools[]`.
- `client_id_secret`, `client_secret_secret`: upper snake case and declared in `secrets`. Seed them as publisher secrets, or the platform answers 409 `publisher_misconfigured`.

### `lifecycle`

`{ on_connect?, on_disconnect? }`. Not read by the platform. For hooks, declare tools named `on_install`, `on_upgrade`, `on_uninstall` or `on_actor_retired` instead.

## Agent templates

### `agent_config`

Required when `kind` is `"agent"`. `persona` (required), `model_tier`, `role`, `settings`, `channels` (`{ webchat?, slack?, telegram?, whatsapp? }`) and `recommended_apps` (`[{ slug, required, reason }]`).

```json
"agent_config": { "persona": "You are the Acme CRM assistant.", "recommended_apps": [{ "slug": "acme-crm", "required": true, "reason": "Its data source." }] }
```

### `training_index`

For `kind: "agent"` only. The schema of the agent's training-data index, in the same shape as `data_index` (`searchable_attributes`, `attributes_for_faceting`, `description`). Not validated; read when the agent is published.

```json
"training_index": { "searchable_attributes": ["question", "answer"] }
```

## Versions and republishing

- `metadata.version` must be semver-greater than the app's current version. Publish refuses anything else.
- Publishing the exact current version again returns 409 `Version X already exists for this app` and changes nothing, but it starts the rollout of that version to installs again. Use it to retry a rollout, not to ship a change.

## Complete example

A small OAuth integration that passes the validator. It has a description on every tool, a schedule whose tool exists and has a handler, the OAuth callback marked `internal`, client credentials supplied by the publisher, and a generated encryption key. The JSONC comments are for reading only.

```jsonc
{
  "sprigr_app": { "version": "1" },
  "metadata": {
    "name": "Acme CRM",
    "slug": "acme-crm",                     // lowercase words joined by hyphens
    "version": "0.1.0",                     // each publish must be higher
    "description": "Search and update Acme CRM contacts from agent chat.",
    "author": { "name": "Example Pty Ltd", "email": "dev@example.com" },
    "category": "crm",
    "tags": ["crm", "contacts"]
    // no trust_tier: publish refuses it
  },
  "kind": "integration",                    // portal sends the user to connect an account
  "runtime": {
    "entry": "src/app/page.tsx",
    "tier": "ssr",
    "framework": "next"                     // without this, an ssr app fails to build
  },
  "permissions": {
    "scopes": ["tools:register"],           // required on every non-agent app
    "network_domains": ["auth.acme.example", "api.acme.example"]
  },
  "secrets": [
    {
      "key": "ACME_CRM_TOKEN_KEK",
      "label": "Token encryption key",
      "type": "secret",
      "required": true,
      "auto_generate": true,                // minted once per install
      "description": "Encrypts the OAuth tokens this install stores."
    },
    {
      "key": "ACME_CRM_CLIENT_ID",
      "label": "Acme OAuth client id",
      "type": "secret",
      "required": true,
      "publisher_provides": true            // set once with sprigr app set-publisher-secrets
    },
    {
      "key": "ACME_CRM_CLIENT_SECRET",
      "label": "Acme OAuth client secret",
      "type": "secret",
      "required": true,
      "publisher_provides": true
    }
  ],
  "migrations": [
    { "file": "migrations/0001_init.sql", "version": 1, "description": "Settings and token tables." }
  ],
  "tools": [
    {
      "name": "acme_crm",
      "description": "Acme CRM contacts. Actions: search_contacts (query), update_contact (id, fields), connection_status.",
      "handler": "src/handlers/acme-crm.ts",
      "effects": "write",                   // plural: "effect" would be ignored
      "confirmation": {
        "actions": { "update_contact": { "always": true } }
      },
      "input_schema": {
        "type": "object",
        "properties": {
          "action": { "type": "string", "enum": ["search_contacts", "update_contact", "connection_status"] },
          "query": { "type": "string", "description": "search_contacts: text to match." },
          "id": { "type": "string", "description": "update_contact: the contact id." },
          "fields": { "type": "object", "description": "update_contact: fields to change." }
        },
        "required": ["action"]
      }
    },
    {
      "name": "acme_crm_oauth_callback",    // must be <slug with _>_oauth_callback
      "description": "Called by the platform after Acme redirects back with a code. Exchanges it for tokens.",
      "handler": "src/handlers/oauth-callback.ts",
      "internal": true,                     // platform-only entry point
      "input_schema": {
        "type": "object",
        "properties": {
          "code": { "type": "string" },
          "redirectUri": { "type": "string" },
          "state": { "type": "string", "description": "Raw state from /oauth/start; verify its csrf. Refuse a call without it." }
        },
        "required": ["code", "redirectUri", "state"]   // a callback without state could bind another account
      }
    },
    {
      "name": "acme_crm_refresh_tokens",    // app-prefixed, so schedules can name it
      "description": "Refreshes the stored Acme OAuth tokens before they expire.",
      "handler": "src/handlers/refresh-tokens.ts",
      "internal": true,
      "input_schema": { "type": "object", "properties": {} }
    }
  ],
  "schedules": [
    {
      "name": "refresh_tokens",
      "cron": "*/45 * * * *",
      "tool": "acme_crm_refresh_tokens",    // declared above, with a handler
      "scope": "per_install"
    }
  ]
}
```

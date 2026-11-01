# Scopes and trust

Two things decide what a marketplace app can do and who can use it:

- **Scopes** are the platform capabilities an install of your app may use. You declare them in the manifest; the installing company grants them.
- **The trust tier** decides who can see and install your app, and unlocks one capability that only `listed` and `certified` apps get. It belongs to the app, not to a version, and it is not a manifest field.

For publishing mechanics see [publishing an app](../publishing-an-app.md); for every manifest field see the [manifest reference](manifest.md).

## Scopes

Declare the scopes your app needs in `permissions.scopes`:

```json
"permissions": {
  "scopes": ["tools:register", "sprigr.jobs"]
}
```

There are nine scopes:

| Scope | What it unlocks | How it is enforced |
|---|---|---|
| `tools:register` | Registering the tools in your manifest so agents can call them. | Required. Publish refuses a tool or integration app without it: `tools:register scope is required`. |
| `knowledge:read` | Reserved. | Accepted in a manifest. No platform API checks it today, so it grants nothing. |
| `knowledge:write` | Reserved. | Same as `knowledge:read`. |
| `inbox:write` | `env.SPRIGR.inbox.*`: append messages to the company's shared inbox, and manage the folders and mail your app added. | Every inbox call checks it. |
| `sprigr.browser:fetch` | `env.SPRIGR.browser.fetch` and `.screenshot`: a one-shot page load in a headless browser the platform runs for you, rate limited per company. | Every call checks it. |
| `sprigr.jobs` | `env.SPRIGR.jobs.*` (durable background jobs) and `env.SPRIGR.store.*` in its default company scope, which holds values for your app in that one company. | Every jobs and store call checks it. |
| `sprigr.jobs:publisher` | The publisher-scoped store: one namespace shared by every install of your app. Needs `sprigr.jobs` as well. | Every publisher-scope call checks it; a miss answers `publisher_scope_not_granted`. Only your own company's install can read or list the namespace, or write any key. Other installs may only write or delete keys of the form `<prefix>:<their install id>`, to hand records to you. |
| `sprigr.browser:session` | `env.SPRIGR.browser.session.*`: stateful browser sessions that keep cookies across calls, for portals that need a login. Needs `sprigr.jobs` as well. | Every call checks it, then picks a mode. **Owner mode** (your own company's install) also needs `sprigr.jobs:publisher` and has no navigation limit. **Tenant mode** (any other company's install) works only for a `listed` or `certified` app that declares `permissions.network_domains`; every navigation is limited to those domains, and the session and cookies belong to that company. Otherwise it answers `browser_session_not_permitted` or `network_domains_required`. |
| `teams:read` | `env.SPRIGR.teams.*`: the company's teams, and the teams of the person behind the current call. | Every call checks it. "My teams" answers only for the person the platform signed onto the call. |

**How enforcement works.** Each platform API listed above reads the install's granted scopes on every call. A call without the scope gets HTTP 403 with `error: "scope_not_granted"` and the install's `granted_scopes`. Because the check is per call, a scope the company removes stops working on the next call, with no rebuild. Write your code so a 403 `scope_not_granted` degrades the one feature that needs the scope instead of failing everything.

**Unknown scopes are refused.** Publish rejects any scope not in the table with `permissions.scopes: "<scope>" is not a platform scope`, followed by the list of known scopes.

**Legacy inert scopes.** `sprigr.data:read`, `sprigr.data:write` and `sprigr.knowledge:write` appear in older manifests. They grant nothing. Publish still accepts them with an `inert_scope` warning, and a later release will refuse them. Remove them.

**Agent templates** (`kind: "agent"`) have no runtime and no tools, so they declare no scopes.

### Granting scopes at install

Install is the moment a company consents to your scopes.

- The installer grants either your full declared set or a subset of it. The portal's install button grants the full set. `sprigr app install <slug> --scopes tools:register,sprigr.jobs` and the MCP `install_app` tool's `grantedScopes` grant exactly the list given.
- An empty list means the full declared set.
- A scope you did not declare cannot be granted: the install is refused with HTTP 400 and the `undeclared_scopes` that caused it.
- Any member of a company can install an app it is allowed to install (see [trust tiers](#trust-tiers)).

### Scopes on upgrade

> **Not yet implemented.** This section describes decision 0328, which is in review. Today an upgrade grants every newly declared scope straight away, with no pending state and no approval. Design for the behaviour below, but do not rely on it as a safety net yet.

Under decision 0328, a new version that declares a scope the install has not granted does **not** gain it silently.

1. The upgrade itself runs as usual: the new code is built and deployed to every tracking install.
2. Each newly declared scope is held as **pending** on the install. A declared scope the installer left out at install time is held the same way on the next upgrade.
3. Until the scope is approved, every call that needs it answers 403 `scope_not_granted`, exactly as for an install that never had it. Everything the install already granted keeps working.
4. The company's owner or an admin sees a **New permissions requested** card on the installed app's page in the portal, with one plain sentence per scope saying what it allows and the version that asked for it. Installs with pending scopes are also counted on the dashboard's approvals page.
5. **Approve** grants the scope; the next call that needs it succeeds. **Deny** records a refusal, and later upgrades do not ask again. A denied scope can be restored to pending from the same page.
6. The page also lists every granted scope with a **Remove** action, so a company can withdraw a scope at any time.

A scope that a later version stops declaring is dropped from pending. Each held scope and each decision is recorded in the install's Recent issues feed.

So when you add a scope in a new version:

- ship the code so the feature that needs the scope is optional until it is granted;
- handle `scope_not_granted` by telling the user an owner or admin needs to approve the new permission;
- say in your release notes which scope you added and why.

### The data an app can reach

An install reads and writes its own per-install database, KV, files and secrets. Beyond that:

- **Collections.** An app can read and write only the collections its own install defined.
- **Another app's data.** Call that app instead: its tools through `app_dependencies`, an [interface](../interfaces/) it implements, or cross-app tools the company has granted (`cross_tenant_tools`). See [marketplace app development](../marketplace-app-development.md) for these declarations.

## Trust tiers

| Tier | Who sees it in the marketplace | Who can install it |
|---|---|---|
| `private` | Your company only | Your company only |
| `shared` | Your company only; others open it through the share link | Your company, and any company with the share link |
| `listed` | Every company | Every company |
| `certified` | Every company, with a **Certified by Sprigr** badge | Every company |

A company that already has an install keeps seeing and using the app whatever its tier becomes later.

### Moving between tiers

| From | To | How | Who |
|---|---|---|---|
| (new app) | `private` | The first publish. | Automatic |
| `private` | `shared` | `sprigr app share <slug>`, the MCP `share_app` tool, or the **Share** button on the app's page. Returns the share link. | The publisher |
| `shared` | `private` | The MCP `unshare_app` tool (`DELETE /api/v1/data/apps/<slug>/share`). Revokes the link. On a `listed` or `certified` app it only revokes the link; the tier stays. | The publisher |
| `private` or `shared` | `listed` | `POST /api/v1/data/apps/<slug>/publish`, the MCP `publish_app_listing` tool, or the **List publicly** button. No review step. | Any member, or any write-capable API key, of the publisher company |
| `listed` | `certified` | Review by Sprigr. Ask at platform@sprigr.com. | Sprigr only |
| any | any | An administrative change, for example taking an app out of the marketplace. | Sprigr only |

Publishing a new version never changes the tier. The listing call refuses an app that is already `certified`. There is no self-serve way to move a listed app back to private; ask Sprigr.

`trust_tier` is not a manifest field. Publish refuses a manifest that sets it. The tier lives on the app record and changes only through the actions in the table.

### What each tier changes

| | `private` | `shared` | `listed` | `certified` |
|---|---|---|---|---|
| Appears in other companies' marketplace | No | No | Yes | Yes, with the Certified badge |
| Installable by other companies | No | With the share link | Yes | Yes |
| Shown to other companies as an implementer of an interface | Only through a direct offer | Only through a direct offer | Yes | Yes |
| Browser sessions in tenant mode (`sprigr.browser:session` on another company's install) | No | No | Yes | Yes |

Scopes are granted per install, not per tier. A `listed` app gets no scope its installer did not grant, and a `private` app installed in your own company gets every scope you granted it.

## See also

- [Publishing an app](../publishing-an-app.md): sharing, listing, upgrades and uninstall.
- [Manifest reference](manifest.md): `permissions`, `network_domains` and every other field.
- [Platform reference](../platform-reference.md): the `env.SPRIGR.*` APIs these scopes gate.

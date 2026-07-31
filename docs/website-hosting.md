# Website hosting: build and run a website on Sprigr, entirely from the CLI

Sprigr Tenant Hosting serves websites for your workspace: plain static sites or Next.js apps, each with its own URL, environment variables, custom domains, deploy history with rollback, and an activity log. Everything below works from the terminal with `@sprigr/cli`: you never need the portal, though every site also appears in the portal's **Websites** section.

This is a different surface from marketplace apps (which are installed per tenant and expose tools to agents; see [build-guide.md](build-guide.md)). A website is just yours: create it, deploy files to it, point a domain at it.

## Prerequisites

```bash
npm install -g @sprigr/cli     # needs >= 0.3.0; `sprigr --help` shows the version's commands
sprigr login                   # device flow; approve in the browser while signed in
sprigr whoami                  # confirm which workspace you're acting as
```

Accounts are created at https://team.sprigr.com/signup (see [getting-started.md](getting-started.md) sections 2-3 for details on signup and login).

## 1. Create the site

```bash
sprigr site create --name "My Docs"
#   created site_abc123 (my-docs)
#   live at https://<workspace>-my-docs.sites.sprigr.com (starter page deployed)
```

Creation deploys a starter page immediately, so the printed URL is live before your first deploy. The `site_...` id is what every other command takes.

Options: `--slug` (defaults to a slug of the name; the workspace prefix is stripped so URLs don't stutter), `--description`, `--type website|landing|docs` (dashboard categorization only), `--visibility public|private`, and `--agent <agentId>` to wire the starter page's chat widget to one of your Sprigr agents.

## 2. Build locally, then deploy

Build the site however you like. For a static site, all you need is a directory with `index.html` at the root plus assets. Verify with any local static server; nothing Sprigr-specific runs client-side.

```bash
sprigr deploy site_abc123 --dir ./public                            # static
sprigr deploy site_abc123 --dir ./.open-next --framework next       # Next.js via @opennextjs/cloudflare
```

Every deploy is the **complete site, not a diff**: include all files each time. Caps: 500 files, 5 MiB per file. `static` and `next` are the frameworks accepted today (`astro`/`remix` flags exist ahead of platform support). The CLI bundles, uploads, and polls the server-side build to a terminal status; exit code 0 means the new deployment is live.

Follow-ups:

```bash
sprigr builds list site_abc123               # build history
sprigr builds get  site_abc123 <buildId>     # one build + its captured log (SSR builds)
sprigr pull        site_abc123 --dir ./out   # download the currently deployed source
```

`sprigr pull` is the recovery path when the original source directory is gone: pull, edit, deploy again.

## 3. Status, rollback, logs

```bash
sprigr site status site_abc123          # site row, live URL, active deployment id, recent builds
sprigr site deployments site_abc123     # every deployment, newest first
sprigr site rollback site_abc123 <deploymentId>   # flip the live pointer back
sprigr site logs site_abc123            # platform activity: deploys, env/domain changes, serve errors
```

Rollback is atomic (the deployment pointer flips and the serve cache invalidates). Roll forward the same way: pick the newer deployment id.

## 4. Environment variables and secrets

```bash
sprigr env set site_abc123 API_KEY=sk_live_x DATABASE_URL='postgres://u:p@h/db?sslmode=require'
sprigr env set site_abc123 NEXT_PUBLIC_FLAG=on --plain --build-time
sprigr env list site_abc123
sprigr env unset site_abc123 API_KEY
```

Semantics worth knowing:

- Values are **write-only**: encrypted at rest, and no read path returns them. `env list` shows metadata and a value hash only. Keep your own copy.
- Setting an existing key **rotates** it.
- Keys default to secret + runtime. `--build-time` also injects during builds (required for `NEXT_PUBLIC_*` inlining); `--no-runtime` makes a key build-only (npm tokens); `--plain` marks it non-secret.
- `--env production|staging|preview` scopes the variable (default `production`).
- On a live SSR site, runtime changes hot-swap into the running worker when possible; the CLI tells you when they will instead apply on the next deploy.

## 5. Custom domains

```bash
sprigr domain add site_abc123 www.example.com
```

`domain add` registers the hostname with Cloudflare for SaaS and prints the DNS records to publish. **Order matters, and the CLI prints it in order:**

1. The **ownership TXT** record.
2. The **ssl-cert TXT** records (`_acme-challenge...`). With these in place the certificate pre-issues while your site still serves from wherever it serves today (zero traffic impact).
3. The **CNAME cutover** (`www.example.com → custom.sites.sprigr.com`): flip this **last**, only after verify reports ssl active.

Then poll:

```bash
sprigr domain verify site_abc123 www.example.com
```

`verify` re-reads Cloudflare's live state and reports the current state (`pending`, `verifying`, `active`, or `failed`). It exits `0` once fully active and `3` while still verifying, so a script can loop on the exit code. While verifying it re-prints the outstanding records. Cloudflare sometimes generates the ssl-cert TXT records only after registration, so always trust the latest `verify` output over the original `add` output.

```bash
sprigr domain list   site_abc123
sprigr domain remove site_abc123 www.example.com --yes
```

Failure modes:

- `Custom hostnames ending in example.com ... are prohibited`: Cloudflare rejects reserved test domains; use a domain you control.
- `hostname_already_registered` (409): the hostname is attached to another of your sites; remove it there first.
- `custom hostname does not CNAME to this zone` in verify errors: expected until you flip the CNAME; it does not block cert pre-issuance from the TXT records.
- A `failed` domain is terminal: `domain remove` it and re-add.
- Custom domains are plan-gated (a limit-reached add returns the plan error).

## 6. Private sites and previews

A `--visibility private` site returns the login page to anonymous visitors. To view one (or let a CI check fetch it):

```bash
sprigr site preview site_abc123     # prints a 15-minute authenticated URL
```

Opening the URL sets a short-lived preview cookie for the rest of the browser session.

## 7. Delete

```bash
sprigr site delete site_abc123 --yes
```

Soft-deletes: the site disappears from lists and stops serving, then a 30-day grace period passes before the platform purges files, builds, and custom hostnames permanently.

## Agent parity

Everything on this page is also available to Sprigr agents through platform tools (`create_website`, `start_build`, `website_status`, `set_website_env`, `add_domain`, `rollback_deployment`), so an agent in your workspace can manage the same sites you manage from the CLI. Ask it in plain language ("put up a landing page for the spring promo"). The ids are shared, so you can create a site in chat and deploy to it from your terminal, or vice versa.

# Getting started: zero to a published Sprigr marketplace app

This is the complete setup path for a developer who has never touched Sprigr. It gets your machine, your account, and your first app from nothing to published. The [build-guide](build-guide.md) is the detailed walkthrough of the app itself; this page covers everything around it.

## 1. Machine prerequisites

- **Node.js >= 22.5** (the local dev harness uses Node's built-in SQLite; everything else works on Node 20+). Check with `node --version`; install via [nvm](https://github.com/nvm-sh/nvm) or nodejs.org.
- **pnpm** (the kit is a pnpm workspace): `corepack enable && corepack prepare pnpm@latest --activate`, or `npm install -g pnpm`.
- **git**.

## 2. Create your Sprigr account

1. Go to **https://team.sprigr.com/signup** and create an account.
2. Complete onboarding — this creates your company workspace. That workspace is your **publisher tenant**: apps you publish belong to it, and its agents are where you'll test installs.

If your company already uses Sprigr, ask a workspace admin to invite you instead of creating a second workspace.

## 3. Install the CLI and log in

```bash
npm install -g @sprigr/cli     # needs >= 0.2.0; `sprigr --help` shows the version's commands
sprigr login
```

`sprigr login` runs a device flow: it prints a URL (and opens your browser), you approve the request in the portal while signed in, and the CLI writes an API key to `~/.config/sprigr/credentials.json` (file mode 0600). No password ever touches the terminal. Verify with `sprigr whoami`.

## 4. Get the kit and scaffold your app

```bash
git clone https://github.com/sprigr/sprigr-app-kit
cd sprigr-app-kit
pnpm install
pnpm create:app <your-slug>    # kebab-case, unique on the marketplace
pnpm install                   # registers the new workspace package
```

The scaffolder generates a working skeleton under `apps/<your-slug>/`: manifest, per-install database migration, OAuth start route + callback handler with CSRF handling, a tool handler stub, a settings page, tests, and a printed TODO checklist with your slug already substituted into every URL. Pick the slug carefully — install URLs, OAuth routing, and tool names all key off it.

## 5. Register your OAuth app with the provider

If your app connects to a third-party API via OAuth, create a **developer app** on the provider's side (their developer portal) and register these redirect URIs:

- `http://localhost:8666/<your-slug>/oauth/callback` — on a **dev/test** OAuth app, for local testing (step 7).
- `https://oauth-bouncer.sprigr.com/<your-slug>/oauth/callback` — production.
- `https://staging-oauth-bouncer.sprigr.com/<your-slug>/oauth/callback` — only if Sprigr has given you staging access; otherwise skip.

Note the client id + client secret; you'll use fake values locally and seed the real ones after first publish (step 8).

## 6. Build the app

Follow the [build-guide](build-guide.md) from step 1 (provider facts) through step 5 (tools). In practice you fill four generated files (provider endpoints, callback completion, your API client, your tool actions); the [harvest example](../examples/harvest) shows every one of them filled in for a real provider. Then verify:

```bash
pnpm -F <your-slug> typecheck && pnpm -F <your-slug> test && pnpm -F <your-slug> build
pnpm verify:local
sprigr app validate --dir apps/<your-slug>     # manifest gate; no login needed
```

## 7. Test everything locally — before any publish

```bash
sprigr app dev --dir apps/<your-slug>
```

This runs your tool handlers and the **entire OAuth callback loop** (CSRF verify → token exchange against the provider's real endpoint → per-install database writes) on your machine, against a local SQLite-backed copy of your per-install D1. No Sprigr account is needed for this step. The startup banner prints copy-pasteable curl templates; [build-guide step 6](build-guide.md#8-step-6-settings-ui-and-local-verification) has the full recipe, including driving the OAuth callback by hand with fake credentials (the provider's invalid-client error is the proof the loop works). Secrets go in `apps/<your-slug>/.sprigr/dev/secrets.json` and are picked up per request — edit and re-curl, no restarts.

## 8. Publish and connect for real

```bash
sprigr app publish --dir apps/<your-slug>
sprigr app bouncer-status <your-slug>     # exit 0 = OAuth routing live; prints the redirect URI to double-check with your provider
sprigr app set-publisher-secrets <your-slug> --secrets '{"<PREFIX>_CLIENT_ID":"...","<PREFIX>_CLIENT_SECRET":"..."}'
```

Then in your portal (team.sprigr.com): install the app from the marketplace tab, open its settings page, click Connect, sign in at the provider, and exercise a tool through an agent chat. [Build-guide step 7](build-guide.md#9-step-7-publish-and-shake-down) is the full shakedown checklist.

## 9. Shipping updates

Every release needs a version bump first:

```bash
pnpm bump <your-slug> patch
pnpm verify:local
sprigr app publish --dir apps/<your-slug>
```

Existing installs pick the new version up via the portal's Upgrade banner or `sprigr app upgrade <your-slug>`.

## Where to get help

- The [build-guide troubleshooting table](build-guide.md#10-troubleshooting) covers the common failures.
- `sprigr app bouncer-status <your-slug>` self-diagnoses OAuth routing; only contact platform@sprigr.com if it reports your app as **disabled**.
- Anything else: platform@sprigr.com.

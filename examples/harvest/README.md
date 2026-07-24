# Harvest (`harvest`)

Connects a tenant's [Harvest](https://www.getharvest.com/) time-tracking
account and exposes one agent tool (`harvest`) with actions to list
clients, list projects, list task assignments, list time entries, and
create time entries (or start a running timer).

- OAuth2 against Harvest ID (`id.getharvest.com`), routed through the
  publisher-shared bouncer. Tokens live in the per-install D1
  (`harvest_secrets`); refresh rotation via the vendored oauth-utils.
- Data calls hit `api.harvestapp.com/v2` with the `Harvest-Account-Id`
  header. The granted account id is resolved from
  `id.getharvest.com/api/v2/accounts` during the OAuth callback and
  stored in `harvest_settings`.

## Publisher setup

1. Register a Harvest developer app at https://id.getharvest.com/developers
   with BOTH bouncer redirect URIs:
   - `https://oauth-bouncer.sprigr.com/harvest/oauth/callback`
   - `https://staging-oauth-bouncer.sprigr.com/harvest/oauth/callback`
2. After first publish, seed publisher secrets per env:
   `sprigr app set-publisher-secrets --slug harvest HARVEST_CLIENT_ID=... HARVEST_CLIENT_SECRET=...`
   (current values are placeholders; nothing works end-to-end until real
   credentials are seeded).

Scaffolded by `pnpm create:app`. See
[docs/marketplace-app-development.md](../../docs/marketplace-app-development.md)
for the full build/publish guide.

# @sprigr/apps-d1-kv

Per-install D1 key-value helpers for marketplace apps. Two flavours over the
same table shape `(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
NOT NULL)`, which the app owns via its own migration:

- `makeSettingsStore` for non-sensitive install state (`get` / `set` /
  `delete` / `getAll`).
- `makeD1TokenStore` for credential material, `TokenStore`-compatible with
  `@sprigr/apps-oauth-utils`.

This is the canonical source. `sprigr-apps` carries a vendored mirror at
`packages/d1-kv` for the handful of apps that use the vendor mechanism rather
than the npm pin; keep the two identical.

## At-rest encryption (`makeD1TokenStore`)

`makeD1TokenStore` holds provider credentials (OAuth refresh tokens, access
tokens, and in a few apps the OAuth client secret), so it takes a **required**
`encryption` option. There is no default, because the failure mode of a default
would be silent: a store that quietly wrote cleartext looks identical to one
that works.

```ts
makeD1TokenStore({
  db,
  table: 'acme_secrets',
  encryption: { mode: 'encrypt', kek: env.ACME_TOKEN_KEK },
});
```

Modes:

| mode | reads | writes |
| --- | --- | --- |
| `encrypt` | sealed and legacy cleartext, re-sealing a legacy row on read | AES-GCM sealed |
| `decrypt-only` | sealed and legacy cleartext | cleartext |
| `cleartext` | cleartext only (a sealed row throws) | cleartext |

`encrypt` and `decrypt-only` throw at construction when `kek` is absent or
blank. The store never falls back to cleartext on its own.

The construction is the one `apps/email-imap-pop` already uses: SHA-256 of the
KEK gives a 256-bit AES-GCM key, and each value is sealed under a fresh 96-bit
IV. Sealed values carry a `sprigr.enc.v1.` prefix, which is what lets a reader
tell them from pre-existing cleartext rows with no migration and no backfill.

`decrypt-only` exists for the rollback-safe first release of an app: once a
decrypt-capable build is the oldest build you would roll back to, flip that app
to `encrypt`.

**The KEK is per install.** Declare it in the app manifest as a `secret` with
`auto_generate: true` so the platform mints 32 random bytes per install and the
publisher never sees it. Note that a secret added to a manifest **after** the
app's first publish is only provisioned to *new* installs; installs that
already exist keep `env.<KEY> === undefined` (sprigr-team's
`backfillInstallPublisherSecrets` covers `publisher_provides` only). Adopt
`encrypt` in an app with live installs only once that gap is closed, or every
one of them will throw at construction.

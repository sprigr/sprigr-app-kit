# @sprigr/apps-d1-kv

Per-install D1 key-value helpers for marketplace apps. Two flavours over the
same table shape `(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
NOT NULL)`, which the app owns via its own migration:

- `makeSettingsStore` for non-sensitive install state (`get` / `set` /
  `delete` / `getAll`).
- `makeD1TokenStore` for credential material, `TokenStore`-compatible with
  `@sprigr/apps-oauth-utils`.

This is the canonical source. `sprigr-apps` apps take it from npm at an exact
pin; the vendored mirror that repo once carried at `packages/d1-kv` is gone.

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
publisher never sees it. A secret added to a manifest **after** the app's first
publish reaches an existing install on that install's next upgrade to a version
that declares it (sprigr-team#7025): best effort, and mint-once. Adopt `encrypt`
in an app with live installs only once every one of them holds the key
(`marketplace.upgrade.auto_secrets_backfilled` in system logs, and no
`required_secrets_missing` for it), or each one without it will throw at
construction.

## Sealing a value outside the token store

`makeD1TokenStore` only covers a `(key, value, updated_at)` table. Credential
material held elsewhere, such as token columns on a per-user row, uses the same
envelope directly:

```ts
import { encryptValue, decryptValue, isEncryptedValue } from '@sprigr/apps-d1-kv';

const sealed = await encryptValue(env.ACME_TOKEN_KEK, refreshToken);
// ...
const plain = await decryptValue(env.ACME_TOKEN_KEK, stored, 'acme_users.refresh_token');
```

- `encryptValue(kek, plaintext)` returns `sprigr.enc.v1.<iv>.<ciphertext>`
  under a fresh IV. It throws when `kek` is absent, blank, or decodes to fewer
  than 16 bytes.
- `decryptValue(kek, stored, label)` returns a value without the envelope
  unchanged, without touching the key, so a reader handles legacy cleartext
  rows and a missing key costs nothing until a sealed value is read. A sealed
  value with a wrong or missing key, or one that was altered, throws.
- `label` names the value in an error (`table.column`). It must never be the
  value: a thrown message can reach an audit row.
- Values are interchangeable with the store's: a value sealed here opens
  through `makeD1TokenStore` under the same KEK, and the other way round.

What the store does for you, you do yourself here: read both forms during the
move, write sealed values only once every install holds the key, and re-seal a
legacy value with a compare-and-set (`UPDATE ... WHERE col = <the value read>`)
so a write that lands between the read and the re-seal is not overwritten.

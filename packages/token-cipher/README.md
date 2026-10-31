# @sprigr/apps-token-cipher

Seal and open the OAuth tokens an app keeps in its own D1 columns, under the
install's platform-minted key-encryption key. The envelope is
`@sprigr/apps-d1-kv`'s (`sprigr.enc.v1.`, AES-GCM, a fresh IV per value).

```ts
import { tokenCipher, tokenKekBound, revocableToken, TokenKeyError } from '@sprigr/apps-token-cipher';

type Field = 'xero_actor_tokens.access_token' | 'xero_actor_tokens.refresh_token';

/** Release A. Release B moves this to 'encrypt'. Kept per app. */
export const TOKEN_CIPHER_MODE = 'decrypt-only' as const;

const cipher = tokenCipher<Field>({
  kek: env.XERO_ACCOUNTING_TOKEN_KEK,
  binding: 'XERO_ACCOUNTING_TOKEN_KEK',
  provider: 'Xero',
  mode: TOKEN_CIPHER_MODE,
  notKept: 'token was not stored', // default: 'credential was not stored'
});

const refresh = await cipher.open(row.refresh_token, 'xero_actor_tokens.refresh_token');
const toStore = await cipher.seal(newRefreshToken);
```

## Modes

- `decrypt-only` (release A): reads both forms, writes cleartext. This is the
  rollback floor. A build older than release A cannot read a sealed value and
  would send it to the provider as a token, so never roll back past A once B
  has shipped.
- `encrypt` (release B): seals on write. An already-sealed value is stored as
  it is.

## Errors

`open` throws `TokenKeyError` for a sealed value it cannot open (no key, a
wrong key, an altered value) and for a value sealed twice. `seal` throws it in
`encrypt` mode when the key is missing or unusable. Messages name the field
and the binding, never a value.

The caller decides what a `TokenKeyError` means. An OAuth app must stop the
call, send nothing to the provider, and never map it to `invalid_grant`. An
app that can re-mint (github's installation token) may treat it as a cache
miss. Pass `contactSupport: false` when the caller recovers by itself.

## Revoke on disconnect or uninstall

```ts
const token = await revocableToken(
  cipher,
  [[row.refresh_token, 'xero_actor_tokens.refresh_token'], [row.access_token, 'xero_actor_tokens.access_token']],
  (msg) => console.warn(`[xero] on_uninstall: not revoking at Xero: ${msg}`),
);
```

It returns the first candidate that opens to a non-empty token. If a sealed
candidate cannot be opened, it returns null and reports why, so the caller
skips the revoke and still deletes its row.

`tokenKekBound(kek)` is true when the key is a non-blank string.

Test KEKs must be at least 16 bytes: d1-kv refuses shorter ones.

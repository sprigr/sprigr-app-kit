# `@sprigr/apps-redact`

One function, `redactSecrets(text)`, that strips credential-shaped values out
of a string before it is written somewhere durable.

```ts
import { redactSecrets } from '@sprigr/apps-redact';

await env.DB.prepare('INSERT INTO my_audit (kind, detail) VALUES (?, ?)')
  .bind(kind, redactSecrets(detail).slice(0, 1000))
  .run();
```

## Why

Apps persist failure detail into per-install audit tables (`*_audit.detail`,
`*_audit.error`, `*.last_error`), and several of them read those rows back to
an agent tool caller or render them on the app's public settings page. The
strings that land there are usually built by interpolating a provider's raw
HTTP response body into an `Error` message. A token endpoint's error body is
provider-controlled and echoes back the request that failed, so an
authorization `code`, a `client_secret` or a `refresh_token` can reach a
durable column with a length cap as the only transform. See issue sprigr/sprigr-apps#560.

## Policy

**Removed** (replaced with the visible marker `[redacted]`):

- JSON and form-encoded values whose KEY names a credential: anything
  containing `secret`, `token`, `password`, `credential`, `api_key`,
  `authorization`, `private_key`, `signature`, `hmac`, `cookie`, plus
  `code_verifier`, `assertion`, `pwd`.
- Values under an AMBIGUOUS key (`code`, `state`, `nonce`, `auth`,
  `signature`, `hmac`, `session_id`) only when the value itself looks like a
  credential rather than a symbolic error code. `"code":"PERMISSION_DENIED"`
  survives; `code=4/0AVMBsJi...` does not.
- Bare credentials recognisable by their own prefix, with no key at all:
  `Bearer`/`Basic` header values, JWTs, `ya29.`, `1//`, `GOCSPX-`, `AIza`,
  `shpat_`/`shpca_`/`shppa_`/`shpss_`, `xoxb-`/`xapp-`, `EAA…`, `ATATT`,
  `sk-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`.

**Kept**, because the audit row exists to be debugged from:

- HTTP status codes, provider error codes (`invalid_grant`,
  `PERMISSION_DENIED`), `error_description` text, `client_id`, trace and
  correlation ids, URLs, resource identifiers.
- Keys that contain a trigger fragment but are not secrets: `token_type`,
  `expires_in`, `token_endpoint`, `error*`.

**Never truncates.** Callers keep their own caps; this function only replaces
matched values.

## Limits

It is a textual filter, not a proof of absence. A novel credential format with
no recognisable key name and no recognisable prefix passes through. Treat it
as defence in depth behind "do not interpolate raw bodies into messages in the
first place" (which is what `@sprigr/apps-oauth-utils` now does), not as a licence
to.

## Consuming it

Depend on the published package at an exact version and import it by name:

```json
{ "dependencies": { "@sprigr/apps-redact": "0.1.0" } }
```

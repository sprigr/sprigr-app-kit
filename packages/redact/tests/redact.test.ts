import { describe, it, expect } from 'vitest';
import { redactSecrets, redactErrorMessage, SECRET_PLACEHOLDER } from '../src/index';

/**
 * The bodies below are shaped like the real thing: a provider's token
 * endpoint or API error response, of the kind that gets interpolated into
 * an Error message and then written to a `*_audit.detail` column.
 *
 * Two assertions on every case, because both halves matter:
 *   1. the credential is gone (that is the bug in sprigr/sprigr-apps#560), and
 *   2. the status / error code / description survives (that is what the
 *      audit row exists for, and a blanket stripper would destroy it).
 */

// Google-shaped fixtures are split into two literals so the repository's
// secret-scanning push protection does not read these fake values as real
// credentials. The joined string is what the redactor sees.
const GOOGLE_CLIENT_ID_FIXTURE = '1234567890-abc.apps.' + 'googleusercontent.com';
const GOOGLE_CLIENT_SECRET_FIXTURE = 'GOC' + 'SPX-SENTINEL_google_secret_value';

describe('redactSecrets: JSON token-endpoint error bodies', () => {
  it('redacts a Google client_secret and authorization code, keeps error + description', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
      client_id: GOOGLE_CLIENT_ID_FIXTURE,
      client_secret: GOOGLE_CLIENT_SECRET_FIXTURE,
      code: '4/0AVMBsJi-SENTINELauthcode-9xQ',
    });
    const out = redactSecrets(body);

    expect(out).not.toContain(GOOGLE_CLIENT_SECRET_FIXTURE);
    expect(out).not.toContain('4/0AVMBsJi-SENTINELauthcode-9xQ');
    expect(out).toContain('invalid_grant');
    expect(out).toContain('Token has been expired or revoked.');
    // client_id is not a secret and distinguishes invalid_client causes.
    expect(out).toContain(GOOGLE_CLIENT_ID_FIXTURE);
    expect(out).toContain(SECRET_PLACEHOLDER);
  });

  it('redacts a Microsoft identity-platform body but keeps the error codes and trace ids', () => {
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description:
        "AADSTS7000215: Invalid client secret provided. Trace ID: 0a1b2c3d Correlation ID: 9f8e7d6c Timestamp: 2026-09-03 01:02:03Z",
      error_codes: [7000215],
      trace_id: '0a1b2c3d',
      correlation_id: '9f8e7d6c',
      client_secret: 'SENTINEL~ms.client.secret.value.1234',
      refresh_token: '0.AXoASENTINELrefreshtokenvalue',
    });
    const out = redactSecrets(body);

    expect(out).not.toContain('SENTINEL~ms.client.secret.value.1234');
    expect(out).not.toContain('0.AXoASENTINELrefreshtokenvalue');
    expect(out).toContain('AADSTS7000215');
    expect(out).toContain('invalid_client');
    expect(out).toContain('0a1b2c3d');
  });

  it('redacts a Xero / spec-shaped body with a bearer access_token echoed back', () => {
    const body =
      '{"error":"unauthorized_client","error_description":"Client not allowed","access_token":"' +
      'eyJ' + 'hbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWJTRU5USU5FTCI6MX0.SIGNATURESENTINEL"}';
    const out = redactSecrets(body);

    expect(out).not.toContain('SENTINEL');
    expect(out).toContain('unauthorized_client');
    expect(out).toContain('Client not allowed');
  });

  it('leaves a Klaviyo JSON:API error code alone (symbolic, not a credential)', () => {
    const body =
      '{"errors":[{"id":"9a2b","code":"invalid","title":"Invalid input","detail":"filter is malformed","status":400}]}';
    expect(redactSecrets(body)).toBe(body);
  });

  it('leaves a Google API symbolic status code alone', () => {
    const body =
      '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}';
    expect(redactSecrets(body)).toBe(body);
  });
});

describe('redactSecrets: form-encoded and query-string bodies', () => {
  it('redacts a form-encoded token request echoed back in an error', () => {
    const body =
      'error=invalid_request&error_description=Missing+redirect_uri&grant_type=authorization_code&code=SENTINELformcode1234567&client_id=abc123&client_secret=SENTINELformsecret9876543';
    const out = redactSecrets(body);

    expect(out).not.toContain('SENTINELformcode1234567');
    expect(out).not.toContain('SENTINELformsecret9876543');
    expect(out).toContain('error=invalid_request');
    expect(out).toContain('error_description=Missing+redirect_uri');
    expect(out).toContain('grant_type=authorization_code');
    expect(out).toContain('client_id=abc123');
  });

  it('redacts credentials inside a URL that got into a message', () => {
    const msg =
      'redirect failed: https://oauth-bouncer.sprigr.com/cb?state=SENTINELstatevalue0123456&code=SENTINELurlcode0123456789&shop=demo.myshopify.com';
    const out = redactSecrets(msg);

    expect(out).not.toContain('SENTINELurlcode0123456789');
    expect(out).not.toContain('SENTINELstatevalue0123456');
    expect(out).toContain('shop=demo.myshopify.com');
    expect(out).toContain('oauth-bouncer.sprigr.com');
  });
});

describe('redactSecrets: unkeyed credential shapes', () => {
  // Token-shaped fixtures are split into two literals so the repository's
  // secret-scanning push protection does not read these fake values as real
  // credentials. The joined string is what the redactor sees.
  it.each([
    ['Google access token', 'ya29' + '.a0AfB_SENTINELaccesstokenvalue1234'],
    ['Google refresh token', '1/' + '/09SENTINELrefreshtokenvalue123456'],
    ['Shopify admin token', 'shp' + 'at_SENTINEL0123456789abcdef0123'],
    ['Slack bot token', 'xo' + 'xb-1234567890-SENTINELslacktoken'],
    ['Meta access token', 'EA' + 'ASENTINELmetaaccesstokenvalue0123456789'],
    ['GitHub token', 'gh' + 'p_SENTINELgithubtokenvalue0123456'],
    ['OpenAI-style key', 's' + 'k-SENTINELopenaikeyvalue01234567890'],
  ])('redacts a bare %s in free text', (_label, token) => {
    const out = redactSecrets(`upstream said: 401 unauthorized (${token})`);
    expect(out).not.toContain('SENTINEL');
    expect(out).toContain('401 unauthorized');
  });

  it('keeps the scheme word on an Authorization header value', () => {
    const out = redactSecrets('sent header Authorization: Bearer SENTINELbearervalue012345 to /v1/me');
    expect(out).not.toContain('SENTINELbearervalue012345');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('/v1/me');
  });
});

describe('redactSecrets: must not damage app-authored diagnostics', () => {
  it('leaves an app-computed summary untouched', () => {
    const s = JSON.stringify({ customers: 3, defaultCustomerId: '1234567890' });
    expect(redactSecrets(s)).toBe(s);
  });

  it('leaves a fixed app literal untouched', () => {
    const s = 'invalid_oauth_state: csrf missing, unknown, replayed, or expired';
    expect(redactSecrets(s)).toBe(s);
  });

  it('leaves an HTTP status line and provider name untouched', () => {
    const s = 'google code exchange failed (400)';
    expect(redactSecrets(s)).toBe(s);
  });

  it('keeps token_type and expires_in, which contain a trigger fragment but are not secrets', () => {
    const s = '{"token_type":"Bearer","expires_in":3599,"error":"invalid_scope"}';
    const out = redactSecrets(s);
    expect(out).toContain('"token_type":"Bearer"');
    expect(out).toContain('"expires_in":3599');
    expect(out).toContain('invalid_scope');
  });

  it('is a no-op on an empty string', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('never truncates', () => {
    const long = `padding ${'x'.repeat(5000)} tail-marker`;
    expect(redactSecrets(long)).toContain('tail-marker');
    expect(redactSecrets(long).length).toBe(long.length);
  });
});

describe('redactSecrets: options', () => {
  it('honours extraSecretKeys for a provider-specific parameter name', () => {
    const body = '{"error":"bad","xyzzy_ticket":"SENTINELproviderticket"}';
    expect(redactSecrets(body)).toContain('SENTINELproviderticket');
    expect(redactSecrets(body, { extraSecretKeys: ['xyzzy_ticket'] })).not.toContain('SENTINEL');
  });
});

describe('redactErrorMessage', () => {
  it('redacts the message of a thrown Error', () => {
    const err = new Error(
      'google token refresh failed (400): {"error":"invalid_grant","refresh_token":"1/' +
        '/09SENTINELrefreshtoken12345"}',
    );
    const out = redactErrorMessage(err);
    expect(out).not.toContain('SENTINEL');
    expect(out).toContain('invalid_grant');
    expect(out).toContain('(400)');
  });

  it('stringifies a non-Error throw before redacting', () => {
    expect(redactErrorMessage('client_secret=SENTINELthrownstring123456')).not.toContain('SENTINEL');
    expect(redactErrorMessage(undefined)).toBe('undefined');
  });
});

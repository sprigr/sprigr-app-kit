import { describe, expect, it } from 'vitest';
import { classifyOAuthError, describeOAuthFailure } from '../src/errors';

describe('classifyOAuthError', () => {
  it('5xx is transient', () => {
    expect(classifyOAuthError('procore', 500, 'oops')).toMatchObject({ terminal: false, reason: 'transient' });
    expect(classifyOAuthError('procore', 503, '')).toMatchObject({ terminal: false, reason: 'transient' });
  });

  it('invalid_grant + "revoked" in description is terminal', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'The grant has been revoked.' });
    expect(classifyOAuthError('procore', 400, body)).toMatchObject({ terminal: true, reason: 'revoked' });
  });

  it('invalid_grant + "expired" is terminal-expired', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired.' });
    expect(classifyOAuthError('procore', 400, body)).toMatchObject({ terminal: true, reason: 'expired' });
  });

  it('bare invalid_grant (no description) is transient — rotation race', () => {
    const body = JSON.stringify({ error: 'invalid_grant' });
    expect(classifyOAuthError('procore', 400, body)).toMatchObject({ terminal: false, reason: 'transient' });
  });

  it('invalid_client is terminal', () => {
    const body = JSON.stringify({ error: 'invalid_client' });
    expect(classifyOAuthError('procore', 401, body)).toMatchObject({ terminal: true, reason: 'revoked' });
  });

  it('other 4xx body falls through to unknown', () => {
    expect(classifyOAuthError('procore', 422, '{}')).toMatchObject({ terminal: false, reason: 'unknown' });
  });

  it('non-JSON body classifies safely', () => {
    expect(classifyOAuthError('procore', 400, '<html>nope</html>')).toMatchObject({ terminal: false, reason: 'unknown' });
  });
});

describe('classifyOAuthError: parsed body fields (sprigr/sprigr-apps#560)', () => {
  it('surfaces the spec-defined error + error_description', () => {
    const body = JSON.stringify({ error: 'invalid_client', error_description: 'Bad secret' });
    expect(classifyOAuthError('procore', 401, body)).toMatchObject({
      errorCode: 'invalid_client',
      errorDescription: 'Bad secret',
      unparsed: false,
      bodyLength: body.length,
    });
  });

  it('flags a non-JSON body as unparsed and records its size', () => {
    const body = '<html>gateway down</html>';
    expect(classifyOAuthError('procore', 502, body)).toMatchObject({
      errorCode: '',
      errorDescription: '',
      unparsed: true,
      bodyLength: body.length,
    });
  });

  it('treats a JSON scalar body as unparsed (not an OAuth error object)', () => {
    expect(classifyOAuthError('procore', 400, '"nope"')).toMatchObject({ unparsed: true });
  });
});

describe('describeOAuthFailure (sprigr/sprigr-apps#560)', () => {
  it('keeps status, classification, error code and description', () => {
    const info = classifyOAuthError(
      'google',
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    );
    const msg = describeOAuthFailure('google', 'token refresh', 400, info);
    expect(msg).toContain('google token refresh failed (400)');
    expect(msg).toContain('reason=revoked'); // 'revoked' in the description outranks 'expired'
    expect(msg).toContain('error=invalid_grant');
    expect(msg).toContain('error_description=Token has been expired or revoked.');
  });

  it('marks a withheld non-JSON body instead of dropping it silently', () => {
    const body = '<html>client_secret=SENTINELsecret</html>';
    const info = classifyOAuthError('google', 400, body);
    const msg = describeOAuthFailure('google', 'code exchange', 400, info);
    expect(msg).not.toContain('SENTINELsecret');
    expect(msg).toContain('provider body withheld');
    expect(msg).toContain(`${body.length} bytes`);
  });

  it('says nothing about a body when the provider sent none', () => {
    const info = classifyOAuthError('google', 500, '');
    expect(describeOAuthFailure('google', 'token refresh', 500, info)).not.toContain('withheld');
  });
});

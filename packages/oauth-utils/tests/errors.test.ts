import { describe, expect, it } from 'vitest';
import { classifyOAuthError } from '../src/errors';

describe('classifyOAuthError', () => {
  it('5xx is transient', () => {
    expect(classifyOAuthError('procore', 500, 'oops')).toEqual({ terminal: false, reason: 'transient' });
    expect(classifyOAuthError('procore', 503, '')).toEqual({ terminal: false, reason: 'transient' });
  });

  it('invalid_grant + "revoked" in description is terminal', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'The grant has been revoked.' });
    expect(classifyOAuthError('procore', 400, body)).toEqual({ terminal: true, reason: 'revoked' });
  });

  it('invalid_grant + "expired" is terminal-expired', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired.' });
    expect(classifyOAuthError('procore', 400, body)).toEqual({ terminal: true, reason: 'expired' });
  });

  it('bare invalid_grant (no description) is transient — rotation race', () => {
    const body = JSON.stringify({ error: 'invalid_grant' });
    expect(classifyOAuthError('procore', 400, body)).toEqual({ terminal: false, reason: 'transient' });
  });

  it('invalid_client is terminal', () => {
    const body = JSON.stringify({ error: 'invalid_client' });
    expect(classifyOAuthError('procore', 401, body)).toEqual({ terminal: true, reason: 'revoked' });
  });

  it('other 4xx body falls through to unknown', () => {
    expect(classifyOAuthError('procore', 422, '{}')).toEqual({ terminal: false, reason: 'unknown' });
  });

  it('non-JSON body classifies safely', () => {
    expect(classifyOAuthError('procore', 400, '<html>nope</html>')).toEqual({ terminal: false, reason: 'unknown' });
  });
});

import { describe, expect, it } from 'vitest';
import { publicBaseUrl } from '../src/index';

// sprigr-apps#3453: an app built its webhook callback URL from the request's
// X-Forwarded-Host. The install's own origin comes from the platform binding.
describe('publicBaseUrl', () => {
  it('returns the bound origin without a trailing slash or path', () => {
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: 'https://trello-l558l90t.apps.sprigr.com/' })).toBe('https://trello-l558l90t.apps.sprigr.com');
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: ' https://app.example.com/some/path?q=1 ' })).toBe('https://app.example.com');
  });

  it('keeps a non-default port', () => {
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: 'https://app.example.com:8443' })).toBe('https://app.example.com:8443');
  });

  it('returns null when unbound, blank, not https, or unparseable', () => {
    expect(publicBaseUrl({})).toBeNull();
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: '  ' })).toBeNull();
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: 'http://app.example.com' })).toBeNull();
    expect(publicBaseUrl({ SITE_PUBLIC_BASE_URL: 'not a url' })).toBeNull();
  });
});

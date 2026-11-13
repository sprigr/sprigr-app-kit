import { describe, it, expect } from 'vitest';
import { crossOriginWriteSource, isCrossOriginWrite } from '../src/same-origin';

const URL_ = 'https://inst_abc.apps.sprigr.com/api/connection';

function req(method: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, { method, headers });
}

describe('isCrossOriginWrite (sprigr-app-kit#293)', () => {
  it.each([
    ['a tenant site on the same domain (same-site)', { 'sec-fetch-site': 'same-site' }, 'same-site'],
    ['an unrelated site', { 'sec-fetch-site': 'cross-site' }, 'cross-site'],
    ['another host by Origin, no Sec-Fetch-Site', { origin: 'https://evil.sites.sprigr.com' }, 'origin-mismatch'],
    ['a null Origin (sandboxed iframe, data: URL)', { origin: 'null' }, 'origin-mismatch'],
    ['a different scheme on the same host', { origin: 'http://inst_abc.apps.sprigr.com' }, 'origin-mismatch'],
  ])('a POST from %s is a cross-origin write', (_label, headers, source) => {
    expect(crossOriginWriteSource(req('POST', headers))).toBe(source);
    expect(isCrossOriginWrite(req('POST', headers))).toBe(true);
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'post'])('%s counts as a write too', (method) => {
    expect(isCrossOriginWrite(req(method, { 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it.each([
    ['same-origin by Sec-Fetch-Site', { 'sec-fetch-site': 'same-origin' }],
    ['a typed URL or bookmark (none)', { 'sec-fetch-site': 'none' }],
    ['same-origin by Origin', { origin: 'https://inst_abc.apps.sprigr.com' }],
    ['a webhook or server with neither header', {}],
    ['same-origin by Sec-Fetch-Site despite a foreign Origin', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.sites.sprigr.com' }],
  ])('a POST from %s is not', (_label, headers) => {
    expect(crossOriginWriteSource(req('POST', headers))).toBeNull();
    expect(isCrossOriginWrite(req('POST', headers))).toBe(false);
  });

  it('a foreign Referer alone is not a cross-origin write (no Referer fallback)', () => {
    const r = req('POST', { referer: 'https://evil.sites.sprigr.com/page' });
    // Guard the guard: the case is only meaningful if the runtime kept the header.
    expect(r.headers.get('referer')).toBe('https://evil.sites.sprigr.com/page');
    expect(crossOriginWriteSource(r)).toBeNull();
  });

  it('Sec-Fetch-Site outranks a matching Origin', () => {
    const r = req('POST', { 'sec-fetch-site': 'same-site', origin: 'https://inst_abc.apps.sprigr.com' });
    expect(isCrossOriginWrite(r)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('a cross-site %s is never a write', (method) => {
    expect(isCrossOriginWrite(req(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
  });
});

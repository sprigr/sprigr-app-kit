/**
 * fetchFileBytes / fetchFileAsBase64 take a URL the model usually chose, and
 * fetched any host (sprigr/sprigr-app-kit#185): on prod an agent testing an
 * upload tool sent https://example.com/test.pdf and the app fetched it. A URL
 * outside the allowed hosts must be refused before any request is made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileUrlRefusedError, fetchFileAsBase64, fetchFileBytes, type FileUrlRefusal } from '../src/file';

const OK = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });

async function refusal(p: Promise<unknown>): Promise<FileUrlRefusal | 'no_error'> {
  try {
    await p;
    return 'no_error';
  } catch (err) {
    if (err instanceof FileUrlRefusedError) return err.code;
    throw err;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchFileBytes refuses a URL outside its allowed hosts before fetching', () => {
  it('fetches a Sprigr file link by default, prod or staging', async () => {
    const fetchMock = vi.fn(async () => OK());
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchFileBytes('https://files.sprigr.com/k?token=t')).size).toBe(3);
    expect((await fetchFileAsBase64('https://staging-files.sprigr.com/k')).base64).toBe('AQID');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('by default refuses any other host, plain http, a look-alike host and a bare key, with no request', async () => {
    const fetchMock = vi.fn(async () => OK());
    vi.stubGlobal('fetch', fetchMock);
    expect(await refusal(fetchFileBytes('https://example.com/test.pdf'))).toBe('host_not_allowed');
    expect(await refusal(fetchFileAsBase64('https://files.sprigr.com.evil.example/k'))).toBe('host_not_allowed');
    expect(await refusal(fetchFileBytes('http://files.sprigr.com/k'))).toBe('not_https');
    expect(await refusal(fetchFileBytes('comp_x/agt_y/files/a.pdf'))).toBe('bad_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an explicit list is the only hosts allowed, over https', async () => {
    const fetchMock = vi.fn(async () => OK());
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchFileBytes('https://cdn.vendor.example/a.pdf', { allowedHosts: ['cdn.vendor.example'] })).size).toBe(3);
    expect(await refusal(fetchFileBytes('https://files.sprigr.com/k', { allowedHosts: ['cdn.vendor.example'] }))).toBe('host_not_allowed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("'any' allows a public host over http or https, never a private, loopback or link-local one", async () => {
    const fetchMock = vi.fn(async () => OK());
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchFileBytes('http://public.example/a.pdf', { allowedHosts: 'any' })).size).toBe(3);
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/x', 'https://10.0.0.5/x', 'http://localhost:8787/x', 'http://[::1]/x', 'http://printer.local/x']) {
      expect(await refusal(fetchFileBytes(bad, { allowedHosts: 'any' })), bad).toBe('private_address');
    }
    expect(await refusal(fetchFileBytes('ftp://public.example/a', { allowedHosts: 'any' }))).toBe('not_https');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * sprigr/sprigr-app-kit#189. The guard reads `new URL(url).hostname`, and the
 * WHATWG parser rewrites a host before the guard sees it: IPv4 in decimal,
 * octal, hex or short form becomes dotted, and an IPv4 address embedded in
 * IPv6 becomes hex (`[::ffff:127.0.0.1]` -> `[::ffff:7f00:1]`), which the old
 * dotted-only IPv6 regex never matched. Each form a host can arrive in gets
 * its own case; every one must be refused with no request.
 */
describe("'any' refuses every parser-normalised spelling of a private host (#189)", () => {
  const refusedForms: Array<[string, string]> = [
    // IPv4 spellings the parser turns into dotted quads.
    ['decimal IPv4', 'http://2130706433/x'],
    ['octal IPv4', 'http://0177.0.0.1/x'],
    ['hex IPv4', 'http://0x7f000001/x'],
    ['short IPv4', 'http://127.1/x'],
    ['zero host', 'http://0/x'],
    ['0.0.0.0/8, non-zero', 'http://0.1.2.3/x'],
    ['trailing-dot IPv4', 'http://127.0.0.1./x'],
    // IPv4 embedded in IPv6, rewritten to hex.
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/x'],
    ['IPv4-mapped loopback, hex', 'http://[::ffff:7f00:1]/x'],
    ['IPv4-mapped metadata address', 'http://[::ffff:169.254.169.254]/x'],
    ['IPv4-mapped private 10/8', 'http://[::ffff:10.0.0.5]/x'],
    ['IPv4-mapped private 192.168/16', 'http://[0:0:0:0:0:ffff:c0a8:101]/x'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/x'],
    ['SIIT-translated loopback', 'http://[::ffff:0:7f00:1]/x'],
    ['NAT64 well-known prefix to loopback', 'http://[64:ff9b::7f00:1]/x'],
    ['NAT64 local-use prefix', 'http://[64:ff9b:1::a00:5]/x'],
    ['6to4 of loopback', 'http://[2002:7f00:1::1]/x'],
    // IPv6 spellings and ranges.
    ['long-form IPv6 loopback', 'http://[0:0:0:0:0:0:0:1]/x'],
    ['unspecified IPv6', 'http://[::]/x'],
    ['upper-case link-local', 'http://[FE80::1]/x'],
    ['unique-local', 'http://[fd12:3456::1]/x'],
    ['deprecated site-local', 'http://[fec0::1]/x'],
    ['multicast', 'http://[ff02::1]/x'],
    // Names with a trailing dot.
    ['localhost with a trailing dot', 'http://localhost./x'],
    ['*.local with a trailing dot', 'http://printer.local./x'],
  ];

  for (const [what, url] of refusedForms) {
    it(`refuses ${what} (${url})`, async () => {
      const fetchMock = vi.fn(async () => OK());
      vi.stubGlobal('fetch', fetchMock);
      expect(await refusal(fetchFileBytes(url, { allowedHosts: 'any' }))).toBe('private_address');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('still fetches public hosts, including a public IPv4-mapped address and public IPv6', async () => {
    const fetchMock = vi.fn(async () => OK());
    vi.stubGlobal('fetch', fetchMock);
    for (const ok of ['http://[::ffff:8.8.8.8]/x', 'http://[2606:4700:4700::1111]/x', 'https://93.184.216.34/x', 'https://public.example./x']) {
      expect((await fetchFileBytes(ok, { allowedHosts: 'any' })).size, ok).toBe(3);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

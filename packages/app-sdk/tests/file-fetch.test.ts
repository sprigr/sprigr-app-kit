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

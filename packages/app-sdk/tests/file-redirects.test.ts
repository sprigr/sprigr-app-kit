/**
 * fetchFileBytes checked only the URL as written, then fetch followed
 * redirects on its own (sprigr/sprigr-app-kit#188). A URL that passes the
 * guard and answers 3xx to a host the guard refuses was still fetched: a
 * private, loopback or metadata address under 'any', or any host off the list
 * under the default Sprigr file hosts. Every hop must pass the same guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileUrlRefusedError, MAX_FILE_REDIRECTS, fetchFileBytes, type FileUrlRefusal } from '../src/file';

const OK = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
const REDIRECT = (location: string, status = 302) => new Response(null, { status, headers: { location } });

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A fetch that answers from a route table and, like the real runtime, follows
 * a 3xx itself unless the caller asked for `redirect: 'manual'`. Every URL it
 * requests, including the ones it followed on its own, lands in `calls`.
 */
function routes(table: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = String(input);
    for (let hop = 0; hop <= 20; hop++) {
      calls.push({ url, init });
      const respond = table[url];
      const res = respond ? respond() : new Response('not found', { status: 404 });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && init?.redirect !== 'manual') {
        url = new URL(location, url).href;
        continue;
      }
      return res;
    }
    throw new TypeError('too many redirects');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, urls: () => calls.map((c) => c.url) };
}

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

describe("under 'any', a redirect to a private host is refused and never fetched", () => {
  it.each([
    ['loopback', 'http://127.0.0.1/admin'],
    ['loopback as IPv4-mapped IPv6', 'http://[::ffff:7f00:1]/admin'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'http://localhost:8080/'],
    ['a protocol-relative Location to a private host', '//10.0.0.5/x'],
  ])('%s', async (_what, location) => {
    const net = routes({ 'https://public.example/file.pdf': () => REDIRECT(location) });
    expect(await refusal(fetchFileBytes('https://public.example/file.pdf', { allowedHosts: 'any' }))).toBe('private_address');
    expect(net.urls()).toEqual(['https://public.example/file.pdf']);
  });
});

describe('under an allow-list, a redirect off the list is refused and never fetched', () => {
  it('the default Sprigr file hosts', async () => {
    const net = routes({ 'https://files.sprigr.com/k?token=t': () => REDIRECT('https://evil.example/steal') });
    expect(await refusal(fetchFileBytes('https://files.sprigr.com/k?token=t'))).toBe('host_not_allowed');
    expect(net.urls()).toEqual(['https://files.sprigr.com/k?token=t']);
  });

  it('a downgrade to http on the same host', async () => {
    const net = routes({ 'https://files.sprigr.com/k': () => REDIRECT('http://files.sprigr.com/k') });
    expect(await refusal(fetchFileBytes('https://files.sprigr.com/k'))).toBe('not_https');
    expect(net.urls()).toEqual(['https://files.sprigr.com/k']);
  });

  it('an explicit list', async () => {
    const net = routes({ 'https://cdn.vendor.example/a.pdf': () => REDIRECT('https://other.example/a.pdf', 301) });
    expect(await refusal(fetchFileBytes('https://cdn.vendor.example/a.pdf', { allowedHosts: ['cdn.vendor.example'] }))).toBe(
      'host_not_allowed',
    );
    expect(net.urls()).toEqual(['https://cdn.vendor.example/a.pdf']);
  });

  it('the refusal names the redirect, so the agent knows the link itself was fine', async () => {
    routes({ 'https://files.sprigr.com/k': () => REDIRECT('https://evil.example/x') });
    await expect(fetchFileBytes('https://files.sprigr.com/k')).rejects.toThrow(/redirect/i);
  });
});

describe('the hop cap', () => {
  const chain = (n: number) => {
    const table: Record<string, () => Response> = {};
    for (let i = 0; i < n; i++) table[`https://files.sprigr.com/h${i}`] = () => REDIRECT(`/h${i + 1}`);
    table[`https://files.sprigr.com/h${n}`] = OK;
    return table;
  };

  it(`follows ${MAX_FILE_REDIRECTS} redirects`, async () => {
    const net = routes(chain(MAX_FILE_REDIRECTS));
    expect((await fetchFileBytes('https://files.sprigr.com/h0')).size).toBe(3);
    expect(net.calls).toHaveLength(MAX_FILE_REDIRECTS + 1);
  });

  it(`refuses the ${MAX_FILE_REDIRECTS + 1}th without fetching it`, async () => {
    const net = routes(chain(MAX_FILE_REDIRECTS + 1));
    expect(await refusal(fetchFileBytes('https://files.sprigr.com/h0'))).toBe('too_many_redirects');
    expect(net.calls).toHaveLength(MAX_FILE_REDIRECTS + 1);
  });
});

describe('redirects that pass the guard still work (must not regress)', () => {
  it('a same-host redirect with a relative Location', async () => {
    const net = routes({
      'https://files.sprigr.com/old/k': () => REDIRECT('/new/k'),
      'https://files.sprigr.com/new/k': OK,
    });
    const out = await fetchFileBytes('https://files.sprigr.com/old/k');
    expect(out.size).toBe(3);
    expect(out.contentType).toBe('application/pdf');
    expect(net.urls()).toEqual(['https://files.sprigr.com/old/k', 'https://files.sprigr.com/new/k']);
  });

  it("a public link that redirects to a presigned CDN URL under 'any' (procore's source_url)", async () => {
    const presigned = 'https://bucket.s3.amazonaws.com/doc.pdf?X-Amz-Signature=abc';
    const net = routes({
      'https://app.procore.example/files/9/download': () => REDIRECT(presigned, 307),
      [presigned]: OK,
    });
    expect((await fetchFileBytes('https://app.procore.example/files/9/download', { allowedHosts: 'any' })).size).toBe(3);
    expect(net.urls()).toEqual(['https://app.procore.example/files/9/download', presigned]);
  });

  it('a CDN redirect to another host on an explicit list', async () => {
    routes({
      'https://api.vendor.example/f/1': () => REDIRECT('https://cdn.vendor.example/f/1.pdf'),
      'https://cdn.vendor.example/f/1.pdf': OK,
    });
    const out = await fetchFileBytes('https://api.vendor.example/f/1', {
      allowedHosts: ['api.vendor.example', 'cdn.vendor.example'],
    });
    expect(out.size).toBe(3);
  });
});

describe('how each hop is requested', () => {
  it('every request asks for redirect: manual, so the runtime never follows a hop unchecked', async () => {
    const net = routes({ 'https://files.sprigr.com/a': () => REDIRECT('/b'), 'https://files.sprigr.com/b': OK });
    await fetchFileBytes('https://files.sprigr.com/a');
    expect(net.calls.map((c) => c.init?.redirect)).toEqual(['manual', 'manual']);
  });

  it("keeps the caller's headers on a same-origin hop and drops credentials on a cross-origin one", async () => {
    const net = routes({
      'https://api.vendor.example/a': () => REDIRECT('/b'),
      'https://api.vendor.example/b': () => REDIRECT('https://cdn.vendor.example/c'),
      'https://cdn.vendor.example/c': OK,
    });
    await fetchFileBytes('https://api.vendor.example/a', {
      allowedHosts: ['api.vendor.example', 'cdn.vendor.example'],
      init: { headers: { Authorization: 'Bearer t', Cookie: 's=1', Accept: 'application/pdf' } },
    });
    const headers = net.calls.map((c) => new Headers(c.init?.headers));
    expect(headers.map((h) => h.get('authorization'))).toEqual(['Bearer t', 'Bearer t', null]);
    expect(headers.map((h) => h.get('cookie'))).toEqual(['s=1', 's=1', null]);
    expect(headers.map((h) => h.get('accept'))).toEqual(['application/pdf', 'application/pdf', 'application/pdf']);
  });

  it('a 303 after a POST continues as a GET with no body, as fetch itself would', async () => {
    const net = routes({ 'https://files.sprigr.com/a': () => REDIRECT('/b', 303), 'https://files.sprigr.com/b': OK });
    await fetchFileBytes('https://files.sprigr.com/a', { init: { method: 'POST', body: 'x' } });
    expect(net.calls.map((c) => c.init?.method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(net.calls[1]!.init?.body ?? null).toBeNull();
  });

  it('a 3xx with no Location is not followed and fails as an HTTP error', async () => {
    routes({ 'https://files.sprigr.com/a': () => new Response(null, { status: 302 }) });
    await expect(fetchFileBytes('https://files.sprigr.com/a')).rejects.toThrow(/HTTP 302/);
  });

  it("a caller that asked for redirect: 'error' gets its file, and Workers is never sent 'error'", async () => {
    const net = routes({ 'https://files.sprigr.com/a': OK });
    expect((await fetchFileBytes('https://files.sprigr.com/a', { init: { redirect: 'error' } })).size).toBe(3);
    expect(net.calls.map((c) => c.init?.redirect)).toEqual(['manual']);
  });

  it("a caller that asked for redirect: 'error' gets no hop followed: any redirect is refused", async () => {
    const net = routes({ 'https://files.sprigr.com/a': () => REDIRECT('/b'), 'https://files.sprigr.com/b': OK });
    expect(await refusal(fetchFileBytes('https://files.sprigr.com/a', { init: { redirect: 'error' } }))).toBe('too_many_redirects');
    expect(net.urls()).toEqual(['https://files.sprigr.com/a']);
  });

  it("a caller that asked for redirect: 'manual' gets no hop followed", async () => {
    const net = routes({ 'https://files.sprigr.com/a': () => REDIRECT('/b'), 'https://files.sprigr.com/b': OK });
    await expect(fetchFileBytes('https://files.sprigr.com/a', { init: { redirect: 'manual' } })).rejects.toThrow(/HTTP 302/);
    expect(net.urls()).toEqual(['https://files.sprigr.com/a']);
  });
});

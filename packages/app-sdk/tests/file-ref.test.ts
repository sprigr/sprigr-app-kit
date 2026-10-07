import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRefError, readFileRef, resolveFileRef, type FileRefErrorCode } from '../src/file-ref';

const INSTALL = 'inst_abc123';
const COMPANY = 'comp_xyz789';
const ctx = { installId: INSTALL, companyId: COMPANY };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function code(fn: () => unknown): FileRefErrorCode | 'no_error' {
  try {
    fn();
    return 'no_error';
  } catch (err) {
    if (err instanceof FileRefError) return err.code;
    throw err;
  }
}

async function codeOf(p: Promise<unknown>): Promise<FileRefErrorCode | 'no_error'> {
  try {
    await p;
    return 'no_error';
  } catch (err) {
    if (err instanceof FileRefError) return err.code;
    throw err;
  }
}

const inits: Array<RequestInit | undefined> = [];
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  inits.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    inits.push(init);
    return handler(String(url));
  });
  return seen;
}
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) } });

afterEach(() => vi.unstubAllGlobals());

describe('resolveFileRef', () => {
  it('takes exactly one of file_key or file_url', () => {
    expect(code(() => resolveFileRef({}, ctx))).toBe('not_one');
    expect(code(() => resolveFileRef(null, ctx))).toBe('not_one');
    expect(code(() => resolveFileRef({ file_key: 'a.png', file_url: 'https://files.sprigr.com/x' }, ctx))).toBe('not_one');
    expect(code(() => resolveFileRef({ file_key: '   ' }, ctx))).toBe('not_one');
    expect(code(() => resolveFileRef({ file_key: 42 }, ctx))).toBe('not_one');
  });

  it('reads an install key in every form a tool hands out', () => {
    expect(resolveFileRef({ file_key: 'images/cap.png' }, ctx)).toEqual({ kind: 'stored', appKey: 'images/cap.png', filename: 'cap.png' });
    expect(resolveFileRef({ file_key: `_apps/${INSTALL}/images/cap.png` }, ctx)).toMatchObject({ kind: 'stored', appKey: 'images/cap.png' });
    expect(resolveFileRef({ file_key: `_apps/${INSTALL}/~u/h1/images/cap.png` }, ctx)).toMatchObject({ kind: 'stored', appKey: 'images/cap.png' });
  });

  it('refuses workspace keys, other installs, malformed and internal keys', () => {
    expect(code(() => resolveFileRef({ file_key: `${COMPANY}/agents/a/report.pdf` }, ctx))).toBe('workspace_key');
    expect(code(() => resolveFileRef({ file_key: 'comp_other/x.pdf' }, {}))).toBe('workspace_key');
    expect(code(() => resolveFileRef({ file_key: 'agt_123/x.pdf' }, ctx))).toBe('workspace_key');
    expect(code(() => resolveFileRef({ file_key: '_apps/inst_other/x.png' }, ctx))).toBe('other_install');
    expect(code(() => resolveFileRef({ file_key: `_apps/${INSTALL}/` }, ctx))).toBe('malformed_key');
    expect(code(() => resolveFileRef({ file_key: 'tmp/staging.bin' }, { ...ctx, internalPrefixes: ['tmp/'] }))).toBe('internal_key');
  });

  it('fetches only https links on the Sprigr file hosts', () => {
    for (const bad of [
      'https://evil.example/x.png',
      'http://files.sprigr.com/x.png',
      'https://files.sprigr.com.evil.example/x.png',
      'https://app.sprigr.com/x.png',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
    ]) {
      expect(code(() => resolveFileRef({ file_url: bad }, ctx)), bad).toBe('not_sprigr_host');
    }
    expect(code(() => resolveFileRef({ file_url: 'not a url' }, ctx))).toBe('bad_url');
  });

  it('reads a link into this install as its key, and passes another install link through', () => {
    expect(resolveFileRef({ file_url: `https://files.sprigr.com/_apps/${INSTALL}/images/cap.png?token=t&expires=1` }, ctx)).toEqual({
      kind: 'stored',
      appKey: 'images/cap.png',
      filename: 'cap.png',
    });
    const other = `https://staging-files.sprigr.com/_apps/inst_other/x.png?token=t&expires=1`;
    expect(resolveFileRef({ file_url: other }, ctx)).toEqual({ kind: 'url', url: other, filename: 'x.png' });
  });

  it('a company link must be signed and in this company', () => {
    const signed = `https://files.sprigr.com/${COMPANY}/agents/a/photo.jpg?token=t&expires=9`;
    expect(resolveFileRef({ file_url: signed }, ctx)).toEqual({ kind: 'url', url: signed, filename: 'photo.jpg' });
    expect(code(() => resolveFileRef({ file_url: `https://files.sprigr.com/${COMPANY}/agents/a/photo.jpg` }, ctx))).toBe('unsigned_link');
    expect(code(() => resolveFileRef({ file_url: 'https://files.sprigr.com/comp_other/photo.jpg?token=t&expires=9' }, ctx))).toBe('other_company');
    expect(code(() => resolveFileRef({ file_url: signed }, { installId: INSTALL }))).toBe('other_company');
  });

  it('names the field in its messages', () => {
    expect(() => resolveFileRef({}, { ...ctx, label: 'images[1]' })).toThrow(/^images\[1\] takes exactly one/);
  });
});

describe('readFileRef', () => {
  const env = { INSTALL_ID: INSTALL, COMPANY_ID: COMPANY };
  const link = `https://files.sprigr.com/${COMPANY}/agents/a/photo.png?token=t&expires=9`;

  it('reads a link with a time cap and no redirects', async () => {
    const seen = stubFetch(png);
    const got = await readFileRef(env, { file_url: link }, { maxBytes: 1024 });
    expect(got).toEqual({ bytes: PNG, size: PNG.byteLength, contentType: 'image/png', filename: 'photo.png', via: 'url' });
    expect(seen).toEqual([link]);
    expect(inits[0]).toMatchObject({ redirect: 'error' });
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads a stored key through a minted link', async () => {
    const seen = stubFetch(png);
    const url = vi.fn(async () => ({ ok: true, url: 'https://files.sprigr.com/_apps/inst_abc123/images/cap.png?token=m' }));
    const got = await readFileRef({ ...env, SPRIGR: { files: { url } } }, { file_key: 'images/cap.png' }, { maxBytes: 1024 });
    expect(url).toHaveBeenCalledWith('images/cap.png', { expiresIn: 300 });
    expect(got).toMatchObject({ filename: 'cap.png', via: 'bridge' });
    expect(seen).toHaveLength(1);
  });

  it('falls back to the install token when there is no files bridge', async () => {
    const seen = stubFetch(() => Response.json({ ok: true, key: 'images/cap.png', base64: 'iVBORwECAw==', contentType: 'image/png', filename: 'cap.png', bytes: 7 }));
    const got = await readFileRef(
      { ...env, SPRIGR_INSTALL_TOKEN: 'it', SPRIGR_PLATFORM_BASE: 'https://staging-webhooks.sprigr.com' },
      { file_key: 'images/cap.png' },
      { maxBytes: 1024 },
    );
    expect(got).toMatchObject({ bytes: PNG, size: 7, via: 'install_token', filename: 'cap.png' });
    expect(seen[0]).toMatch(/^https:\/\/staging-webhooks\.sprigr\.com\//);
  });

  it('says so when there is no file store at all, without fetching', async () => {
    const seen = stubFetch(png);
    expect(await codeOf(readFileRef(env, { file_key: 'images/cap.png' }, { maxBytes: 1024 }))).toBe('no_file_store');
    expect(seen).toEqual([]);
  });

  it('refuses before fetching anything', async () => {
    const seen = stubFetch(png);
    expect(await codeOf(readFileRef(env, { file_url: 'https://evil.example/x' }, { maxBytes: 1024 }))).toBe('not_sprigr_host');
    expect(seen).toEqual([]);
  });

  it('caps size, time, and reports a missing file', async () => {
    stubFetch(() => new Response(new Uint8Array(2048), { status: 200, headers: { 'content-length': '2048' } }));
    await expect(readFileRef(env, { file_url: link }, { maxBytes: 1024, label: 'image' })).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/^image is/) });

    stubFetch(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(readFileRef(env, { file_url: link }, { maxBytes: 1024, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/5s/) });

    stubFetch(() => new Response('gone', { status: 404 }));
    expect(await codeOf(readFileRef(env, { file_url: link }, { maxBytes: 1024 }))).toBe('not_found');

    stubFetch(() => {
      throw new TypeError('redirect was not allowed');
    });
    expect(await codeOf(readFileRef(env, { file_url: link }, { maxBytes: 1024 }))).toBe('read_failed');
  });
});

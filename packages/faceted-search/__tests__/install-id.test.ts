/**
 * The `#install_id=` hash value reaches a credentialed gateway path
 * (`/installations/<id>/tools/<tool>`, sent with the portal session cookie).
 * Before sprigr-apps#3590 it was URL-decoded and interpolated raw, so a crafted
 * link could put path separators, a query or a fragment into that path and
 * pick a different install and tool than the page declares (sprigr-apps#2443).
 * Only the platform's own id shape may reach the URL now, and it is encoded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewaySearch, invokeTool, isValidInstallId, readInstallId } from '../src/sources/gateway';
import { sourceReady } from '../src/sources';
import type { SearchParams } from '../src/types';

const PARAMS: SearchParams = { query: '', filters: '', facets: [], page: 0, hitsPerPage: 24 };

/** A well-formed id: `inst_` + 20 lowercase letters or digits. */
const GOOD = 'inst_abcdefghij0123456789';

function withHash(hash: string) {
  vi.stubGlobal('window', { location: { hash, hostname: 'app.sites.sprigr.com' } });
}

function mockFetch() {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isValidInstallId', () => {
  it('accepts the platform shape: inst_ plus 20 lowercase letters or digits', () => {
    expect(isValidInstallId(GOOD)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', 'inst_123'],
    ['too long', `${GOOD}0`],
    ['wrong prefix', 'app_abcdefghij0123456789'],
    ['upper case', 'inst_ABCDEFGHIJ0123456789'],
    ['a slash', 'inst_abcdefghij/12345678'],
    ['a dot', 'inst_abcdefghij.123456789'],
    ['a trailing newline', `${GOOD}\n`],
  ])('rejects %s', (_label, id) => {
    expect(isValidInstallId(id)).toBe(false);
  });
});

describe('a crafted #install_id never reaches the gateway', () => {
  it.each([
    ['../ traversal with encoded slashes', '#install_id=..%2F..%2Finst_zzzzzzzzzz0123456789'],
    ['encoded dots and slashes', '#install_id=%2e%2e%2f%2e%2e%2fother'],
    ['an encoded slash after a real id (picks another tool)', `#install_id=${GOOD}%2Ftools%2Fgws_disconnect%3Fx%3D`],
    ['a raw slash and query in the hash', `#install_id=${GOOD}/tools/gws_disconnect?x=`],
    ['an encoded query string', `#install_id=${GOOD}%3Fredirect%3D1`],
    ['an encoded fragment', `#install_id=${GOOD}%23frag`],
    ['an encoded backslash', `#install_id=${GOOD}%5C..`],
    ['malformed percent-encoding', '#install_id=%E0%A4%A'],
  ])('%s: no id, not ready, and no fetch', async (_label, hash) => {
    withHash(hash);
    const fetchFn = mockFetch();
    expect(readInstallId()).toBeNull();
    expect(sourceReady({ kind: 'gateway', toolName: 'search_listings' })).toBe(false);
    await expect(gatewaySearch('search_listings')(PARAMS)).rejects.toThrow(/Sprigr Apps page/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an invalid installId passed in config is refused the same way', async () => {
    withHash('');
    const fetchFn = mockFetch();
    const source = { kind: 'gateway' as const, toolName: 'search_listings', installId: '../inst_other' };
    expect(sourceReady(source)).toBe(false);
    await expect(invokeTool('search_listings', {}, source.installId)).rejects.toThrow(/Sprigr Apps page/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a well-formed #install_id still works', () => {
  it('is read from the hash, makes the source ready, and lands in the path as-is', async () => {
    withHash(`#install_id=${GOOD}&theme=dark`);
    const fetchFn = mockFetch();
    expect(readInstallId()).toBe(GOOD);
    expect(sourceReady({ kind: 'gateway', toolName: 'search_listings' })).toBe(true);
    await gatewaySearch('search_listings')(PARAMS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe(
      `https://api.team.sprigr.com/api/v1/data/marketplace/installations/${GOOD}/tools/search_listings`,
    );
  });

  it('the tool name is encoded too, so it cannot add a path segment', async () => {
    withHash(`#install_id=${GOOD}`);
    const fetchFn = mockFetch();
    await invokeTool('search/../gws_disconnect');
    expect(fetchFn.mock.calls[0]![0]).toBe(
      `https://api.team.sprigr.com/api/v1/data/marketplace/installations/${GOOD}/tools/search%2F..%2Fgws_disconnect`,
    );
  });

  it('the readiness gate still waits for an id rather than calling the gateway without one', () => {
    withHash('#theme=dark');
    expect(sourceReady({ kind: 'gateway', toolName: 'search_listings' })).toBe(false);
    expect(sourceReady({ kind: 'gateway', toolName: 'search_listings', installId: GOOD })).toBe(true);
  });
});

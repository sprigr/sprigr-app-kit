import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewaySearch, gatewayBase } from '../src/sources/gateway';
import {
  searchKeySearch,
  normalizeSearchKeyResponse,
  DEFAULT_SEARCH_HOST,
  defaultSearchHost,
} from '../src/sources/searchKey';
import { resolveSource, sourceReady } from '../src/sources';
import type { SearchParams } from '../src/types';

const PARAMS: SearchParams = { query: 'x', filters: 'status:active', facets: ['status'], page: 0, hitsPerPage: 24 };

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gatewaySearch', () => {
  it('POSTs { args } with snake_case params and unwraps { result }', async () => {
    const fetchFn = mockFetch({
      ok: true,
      result: { hits: [{ objectID: '1' }], nb_hits: 1, page: 0, nb_pages: 1, facet_counts: { status: { active: 1 } } },
    });
    const search = gatewaySearch('search_listings', 'inst_123');
    const res = await search(PARAMS);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain('/marketplace/installations/inst_123/tools/search_listings');
    expect(init!.credentials).toBe('include');
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({
      args: { query: 'x', filters: 'status:active', facets: ['status'], page: 0, hits_per_page: 24 },
    });
    expect(res.nb_hits).toBe(1);
    expect(res.facet_counts).toEqual({ status: { active: 1 } });
  });

  it('accepts a bare result object (no envelope)', async () => {
    mockFetch({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 });
    const res = await gatewaySearch('t', 'inst_1')(PARAMS);
    expect(res.hits).toEqual([]);
    expect(res.nb_hits).toBe(0);
  });

  it('throws on a non-ok response', async () => {
    mockFetch({ error: 'boom' }, false, 500);
    await expect(gatewaySearch('t', 'inst_1')(PARAMS)).rejects.toThrow(/failed \(500\)/);
  });

  it('gatewayBase picks prod when no window (SSR)', () => {
    // In the node test env there is no window, so it defaults to prod.
    expect(gatewayBase()).toBe('https://api.team.sprigr.com');
  });
});

describe('searchKeySearch', () => {
  it('POSTs to /1/indexes/:index/query with the API-key header and snake_case body', async () => {
    const fetchFn = mockFetch({
      hits: [{ objectID: 'a' }],
      nb_hits: 42,
      page: 0,
      nb_pages: 2,
      facets: { status: { active: 30, sold: 12 } },
    });
    const search = searchKeySearch('boardcave_products', 'sk_test');
    const res = await search({ ...PARAMS, hitsPerPage: 24 });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_SEARCH_HOST}/1/indexes/boardcave_products/query`);
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Sprigr-API-Key']).toBe('sk_test');
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({
      query: 'x',
      filters: 'status:active',
      facets: ['status'],
      page: 0,
      hits_per_page: 24,
    });
    // Raw `facets` normalized to `facet_counts`.
    expect(res.facet_counts).toEqual({ status: { active: 30, sold: 12 } });
    expect(res.nb_hits).toBe(42);
    expect(res.nb_pages).toBe(2);
  });

  it('honours a custom host and trims a trailing slash', async () => {
    const fetchFn = mockFetch({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 });
    await searchKeySearch('idx', 'k', 'https://custom.example.com/')(PARAMS);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://custom.example.com/1/indexes/idx/query');
  });

  it('throws on a non-ok response', async () => {
    mockFetch({}, false, 403);
    await expect(searchKeySearch('idx', 'k')(PARAMS)).rejects.toThrow(/failed \(403\)/);
  });
});

describe('defaultSearchHost (staging auto-detect)', () => {
  it('resolves the staging search host on a staging page hostname', () => {
    vi.stubGlobal('window', { location: { hostname: 'demo.staging-sites.sprigr.com' } });
    expect(defaultSearchHost()).toBe('https://staging-search.sprigr.com');
  });

  it('resolves the prod search host on a non-staging hostname', () => {
    vi.stubGlobal('window', { location: { hostname: 'demo.sites.sprigr.com' } });
    expect(defaultSearchHost()).toBe(DEFAULT_SEARCH_HOST);
  });

  it('resolves the prod search host under SSR (no window)', () => {
    expect(typeof window).toBe('undefined');
    expect(defaultSearchHost()).toBe(DEFAULT_SEARCH_HOST);
  });

  it('searchKeySearch resolves the default at CALL time, not at creation', async () => {
    const fetchFn = mockFetch({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 });
    // Created while there is no window (SSR-like)...
    const search = searchKeySearch('idx', 'k');
    // ...then invoked in a staging browser context.
    vi.stubGlobal('window', { location: { hostname: 'demo.staging-sites.sprigr.com' } });
    await search(PARAMS);
    expect(fetchFn.mock.calls[0]![0]).toBe(
      'https://staging-search.sprigr.com/1/indexes/idx/query',
    );
  });

  it('an explicit host always wins over staging detection', async () => {
    vi.stubGlobal('window', { location: { hostname: 'demo.staging-sites.sprigr.com' } });
    const fetchFn = mockFetch({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 });
    await searchKeySearch('idx', 'k', 'https://custom.example.com')(PARAMS);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://custom.example.com/1/indexes/idx/query');
  });
});

describe('normalizeSearchKeyResponse', () => {
  it('maps raw `facets` to `facet_counts`', () => {
    const out = normalizeSearchKeyResponse(
      { hits: [], nb_hits: 0, page: 0, facets: { a: { x: 1 } } },
      PARAMS,
    );
    expect(out.facet_counts).toEqual({ a: { x: 1 } });
  });
  it('prefers an existing `facet_counts` when both are present', () => {
    const out = normalizeSearchKeyResponse(
      { hits: [], nb_hits: 0, page: 0, facets: { a: { x: 1 } }, facet_counts: { b: { y: 2 } } },
      PARAMS,
    );
    expect(out.facet_counts).toEqual({ b: { y: 2 } });
  });
  it('computes nb_pages from nb_hits when the server omits it', () => {
    const out = normalizeSearchKeyResponse({ hits: [], nb_hits: 50, page: 0 }, { ...PARAMS, hitsPerPage: 20 });
    expect(out.nb_pages).toBe(3);
  });
  it('defaults missing fields safely', () => {
    const out = normalizeSearchKeyResponse({}, PARAMS);
    expect(out).toMatchObject({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 });
    expect(out.facet_counts).toBeUndefined();
  });
});

describe('resolveSource / sourceReady', () => {
  it('routes a custom source straight through', async () => {
    const custom = vi.fn(async () => ({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 }));
    const fn = resolveSource({ kind: 'custom', search: custom });
    await fn(PARAMS);
    expect(custom).toHaveBeenCalledWith(PARAMS);
  });
  it('a gateway source with an explicit installId is ready', () => {
    expect(sourceReady({ kind: 'gateway', toolName: 't', installId: 'inst_1' })).toBe(true);
  });
  it('a gateway source with no id and no window is not ready', () => {
    expect(sourceReady({ kind: 'gateway', toolName: 't' })).toBe(false);
  });
  it('non-gateway sources are always ready', () => {
    expect(sourceReady({ kind: 'searchKey', indexName: 'i', apiKey: 'k' })).toBe(true);
    expect(sourceReady({ kind: 'custom', search: async () => ({ hits: [], nb_hits: 0, page: 0, nb_pages: 1 }) })).toBe(true);
  });
});

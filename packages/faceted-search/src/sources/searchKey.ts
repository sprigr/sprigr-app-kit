/**
 * Search-key data source - the agent-built-static-website path.
 *
 * POSTs directly to the Sprigr search API with a search-only API key. Verified
 * against the sprigr-search query route (crates/search-core SearchRequest +
 * the worker response builder in src/lib.rs) and the boardcave.html client:
 *
 *   POST {host}/1/indexes/{indexName}/query
 *   header: X-Sprigr-API-Key: <apiKey>
 *   body:   { query, filters, facets, page, hits_per_page }
 *           (the engine also accepts the camelCase `hitsPerPage` alias)
 *   resp:   { query, hits, nb_hits, page, nb_pages, hits_per_page,
 *             facets?: { attr: { value: count } }, ... }
 *
 * NOTE: the raw search API returns facet counts under `facets`, while the
 * gateway/handler path returns them under `facet_counts`. We normalize the
 * raw `facets` into SearchResult.facet_counts here so both sources feed the
 * UI identically.
 */
import type { SearchParams, SearchResult } from '../types';

/** The PROD search host. Kept exported for compat; prefer defaultSearchHost(). */
export const DEFAULT_SEARCH_HOST = 'https://search.sprigr.com';

const STAGING_SEARCH_HOST = 'https://staging-search.sprigr.com';

/**
 * Resolve the default search host at CALL time, mirroring gatewayBase(): a
 * staging page hostname (e.g. *.staging-sites.sprigr.com) routes to the
 * staging search API, anything else (including SSR, where there is no window)
 * routes to prod. Without this, a site on a staging tenant that omits `host`
 * would query PROD search with a staging key and 403 (Invalid API key). An
 * explicit `host` config always wins over this detection.
 */
export function defaultSearchHost(): string {
  return typeof window !== 'undefined' && window.location.hostname.includes('staging')
    ? STAGING_SEARCH_HOST
    : DEFAULT_SEARCH_HOST;
}

type RawSearchResponse = {
  hits?: Record<string, unknown>[];
  nb_hits?: number;
  page?: number;
  nb_pages?: number;
  hits_per_page?: number;
  /** Raw API returns facet counts under `facets`, not `facet_counts`. */
  facets?: Record<string, Record<string, number>>;
  /** Some clients/versions may already use `facet_counts`; accept it too. */
  facet_counts?: Record<string, Record<string, number>>;
};

/** Normalize a raw search-API response into the UI's SearchResult shape. */
export function normalizeSearchKeyResponse(
  raw: RawSearchResponse,
  params: SearchParams,
): SearchResult {
  const facetCounts = raw.facet_counts ?? raw.facets;
  const nbHits = typeof raw.nb_hits === 'number' ? raw.nb_hits : 0;
  const perPage = params.hitsPerPage > 0 ? params.hitsPerPage : 20;
  const nbPages =
    typeof raw.nb_pages === 'number' ? raw.nb_pages : Math.max(1, Math.ceil(nbHits / perPage));
  return {
    hits: Array.isArray(raw.hits) ? raw.hits : [],
    nb_hits: nbHits,
    page: typeof raw.page === 'number' ? raw.page : params.page,
    nb_pages: nbPages,
    ...(facetCounts ? { facet_counts: facetCounts } : {}),
  };
}

/**
 * Build a search function for a search-key source. When `host` is omitted the
 * default is resolved per search call via defaultSearchHost() (staging page
 * hostnames route to the staging search API); an explicit `host` always wins.
 */
export function searchKeySearch(indexName: string, apiKey: string, host?: string) {
  return async (params: SearchParams): Promise<SearchResult> => {
    const base = (host ?? defaultSearchHost()).replace(/\/+$/, '');
    const res = await fetch(`${base}/1/indexes/${encodeURIComponent(indexName)}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sprigr-API-Key': apiKey,
      },
      body: JSON.stringify({
        query: params.query,
        filters: params.filters || '',
        facets: params.facets,
        page: params.page,
        hits_per_page: params.hitsPerPage,
        // The engine's SearchRequest uses `sort_by` (comma-separated
        // asc()/desc() terms). Forward the selected sort verbatim; it is a
        // no-op when the value isn't a valid sort expression.
        ...(params.sort ? { sort_by: params.sort } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`search failed (${res.status}). ${await res.text().catch(() => '')}`.trim());
    }
    const raw = (await res.json()) as RawSearchResponse;
    return normalizeSearchKeyResponse(raw, params);
  };
}

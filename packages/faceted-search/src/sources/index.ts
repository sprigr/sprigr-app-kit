/**
 * Resolve a FacetBrowseSource into a concrete search function.
 */
import type { FacetBrowseSource, SearchParams, SearchResult } from '../types';
import { gatewaySearch } from './gateway';
import { searchKeySearch } from './searchKey';

export * from './gateway';
export * from './searchKey';

export type SearchFn = (params: SearchParams) => Promise<SearchResult>;

/** Turn any source variant into the single async search function the UI calls. */
export function resolveSource(source: FacetBrowseSource): SearchFn {
  switch (source.kind) {
    case 'gateway':
      return gatewaySearch(source.toolName, source.installId);
    case 'searchKey':
      return searchKeySearch(source.indexName, source.apiKey, source.host);
    case 'custom':
      return source.search;
    default: {
      // Exhaustiveness guard: a new source kind must be handled above.
      const _never: never = source;
      throw new Error(`Unknown faceted-search source: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * A gateway source needs an install id (from config or the URL hash) before it
 * can search. This reports whether that gate is satisfied so the UI can show a
 * "open from the Apps page" notice instead of firing a doomed request. Non-
 * gateway sources are always ready.
 */
export function sourceReady(source: FacetBrowseSource): boolean {
  if (source.kind !== 'gateway') return true;
  if (source.installId) return true;
  if (typeof window === 'undefined') return false;
  return /install_id=([^&]+)/.test(window.location.hash);
}

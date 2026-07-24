/**
 * Gateway data source - the marketplace-app-dashboard path.
 *
 * The app page is embedded in the Sprigr portal as an iframe with
 * `#install_id=` in the URL hash. The UI invokes the install's own tools
 * through the platform gateway, which runs each tool in DISPATCH context with
 * the install's real tenant identity and `env.SPRIGR.data`. So the search UI
 * queries the install's PRIVATE index directly, with no duplicate/public index.
 *
 * Generalized from apps/realestate/src/lib/gateway.ts so apps stop hand-rolling
 * the readInstallId + invokeTool pair.
 */
import type { SearchParams, SearchResult } from '../types';

/** Prod/staging host detection: staging hostnames route to the staging API. */
export function gatewayBase(): string {
  return typeof window !== 'undefined' && window.location.hostname.includes('staging')
    ? 'https://staging-api-team.sprigr.com'
    : 'https://api.team.sprigr.com';
}

/** Parse `#install_id=` from the current URL hash. Null when absent/SSR. */
export function readInstallId(): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.hash.match(/install_id=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Invoke one of the install's tools via the gateway. Returns the tool's JSON
 * return value (unwrapping the `{ result }` envelope when present).
 */
export async function invokeTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown> = {},
  installId?: string,
): Promise<T> {
  const id = installId ?? readInstallId();
  if (!id) {
    throw new Error('Open this search from the Sprigr Apps page (no install context in the URL).');
  }
  const res = await fetch(
    `${gatewayBase()}/api/v1/data/marketplace/installations/${id}/tools/${encodeURIComponent(toolName)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    },
  );
  if (!res.ok) {
    throw new Error(`${toolName} failed (${res.status}). ${await res.text().catch(() => '')}`.trim());
  }
  const json = (await res.json()) as { ok?: boolean; result?: unknown };
  return (json && typeof json === 'object' && 'result' in json ? json.result : json) as T;
}

/**
 * Build a search function for a gateway source. The tool is expected to accept
 * the search_listings argument shape ({ query, filters, facets, page,
 * hits_per_page }) and return a SearchResult-shaped object. This matches the
 * realestate search_listings handler and its sprigr-client normalization.
 */
export function gatewaySearch(toolName: string, installId?: string) {
  return async (params: SearchParams): Promise<SearchResult> => {
    const raw = await invokeTool<Partial<SearchResult>>(
      toolName,
      {
        query: params.query,
        filters: params.filters || undefined,
        facets: params.facets,
        page: params.page,
        hits_per_page: params.hitsPerPage,
        ...(params.sort ? { sort: params.sort } : {}),
      },
      installId,
    );
    return {
      hits: Array.isArray(raw.hits) ? raw.hits : [],
      nb_hits: typeof raw.nb_hits === 'number' ? raw.nb_hits : 0,
      page: typeof raw.page === 'number' ? raw.page : params.page,
      nb_pages: typeof raw.nb_pages === 'number' ? raw.nb_pages : 1,
      ...(raw.facet_counts ? { facet_counts: raw.facet_counts } : {}),
    };
  };
}

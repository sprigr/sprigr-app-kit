/**
 * State + data-fetch hook for the faceted browse UI.
 *
 * Owns: debounced query, selected facet values, numeric ranges, sort, per-facet
 * sub-search text, collapsed groups, current page, and the request lifecycle
 * (loading/error/result with a stale-response guard). Pagination is real: the
 * page resets to 0 whenever the query, filters, or sort change, and the source
 * is re-queried on every page move.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FacetBrowseConfig, SearchResult } from '../types';
import { buildFilterString, combineFilters, type RangeState } from '../utils/filters';
import { resolveSource, sourceReady } from '../sources';

const DEBOUNCE_MS = 160;
const DEFAULT_HITS = 24;

export type FacetBrowseState = ReturnType<typeof useFacetBrowse>;

export function useFacetBrowse(config: FacetBrowseConfig) {
  const facetAttrs = useMemo(() => config.facets.map((f) => f.attr), [config.facets]);
  const rangeAttrs = useMemo(() => (config.ranges ?? []).map((r) => r.attr), [config.ranges]);
  const hitsPerPage = config.hitsPerPage ?? DEFAULT_HITS;

  const searchFn = useMemo(() => resolveSource(config.source), [config.source]);
  const [ready, setReady] = useState<boolean | null>(null);

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(facetAttrs.map((a) => [a, new Set<string>()])),
  );
  const [ranges, setRanges] = useState<Record<string, RangeState>>(() =>
    Object.fromEntries(rangeAttrs.map((a) => [a, { min: null, max: null }])),
  );
  const [sort, setSort] = useState(config.sorts?.[0]?.value ?? 'relevance');
  const [subq, setSubq] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(config.facets.filter((f) => f.collapsed).map((f) => [f.attr, true])),
  );
  const [page, setPage] = useState(0);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setReady(sourceReady(config.source)), [config.source]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // The user-assembled expression, ANDed with the fixed config.baseFilter
  // scoping filter (comma = AND). Combined here, before the source call, so
  // all three sources are scoped identically and facet counts reflect the
  // scoped catalog. See the baseFilter doc comment in types.ts for the
  // plain-AND interaction with user selections on a base-constrained facet.
  const filterString = useMemo(
    () => combineFilters(config.baseFilter, buildFilterString(selected, ranges)),
    [config.baseFilter, selected, ranges],
  );

  // Any change to the query/filters/sort resets pagination to the first page.
  useEffect(() => {
    setPage(0);
  }, [debouncedQ, filterString, sort]);

  const reqId = useRef(0);
  const runSearch = useCallback(async () => {
    if (!sourceReady(config.source)) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await searchFn({
        query: debouncedQ,
        filters: filterString || undefined,
        facets: facetAttrs,
        page,
        hitsPerPage,
        sort: sort || undefined,
      });
      if (id === reqId.current) setResult(res);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [config.source, searchFn, debouncedQ, filterString, facetAttrs, page, hitsPerPage, sort]);

  useEffect(() => {
    if (ready) void runSearch();
  }, [ready, runSearch]);

  const toggle = useCallback((attr: string, v: string) => {
    setSelected((s) => {
      const next = { ...s, [attr]: new Set(s[attr] ?? []) };
      if (next[attr]!.has(v)) next[attr]!.delete(v);
      else next[attr]!.add(v);
      return next;
    });
  }, []);

  const setRange = useCallback((attr: string, next: RangeState) => {
    setRanges((r) => ({ ...r, [attr]: next }));
  }, []);

  const setSub = useCallback((attr: string, v: string) => {
    setSubq((s) => ({ ...s, [attr]: v }));
  }, []);

  const toggleCollapsed = useCallback((attr: string) => {
    setCollapsed((c) => ({ ...c, [attr]: !c[attr] }));
  }, []);

  const clearAll = useCallback(() => {
    setQ('');
    setDebouncedQ('');
    setSelected(Object.fromEntries(facetAttrs.map((a) => [a, new Set<string>()])));
    setRanges(Object.fromEntries(rangeAttrs.map((a) => [a, { min: null, max: null }])));
    setSubq({});
    setPage(0);
  }, [facetAttrs, rangeAttrs]);

  return {
    config,
    facetAttrs,
    hitsPerPage,
    ready,
    q,
    setQ,
    selected,
    toggle,
    ranges,
    setRange,
    sort,
    setSort,
    subq,
    setSub,
    collapsed,
    toggleCollapsed,
    page,
    setPage,
    result,
    loading,
    error,
    filterString,
    runSearch,
    clearAll,
  };
}

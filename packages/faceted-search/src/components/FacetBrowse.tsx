/**
 * <FacetBrowse> - the top-level faceted catalog search component.
 *
 * Server-driven: every query hits the configured data source, and facet counts
 * come back on the same call so the filter rail is always live. Renders a
 * sticky header with the search box + result count, a dark facet rail, active-
 * filter chips, a sort dropdown, result cards (declarative or via renderCard),
 * loading skeletons, empty/error states, and prev/next pagination.
 */
import { type JSX, type ReactNode, useMemo } from 'react';
import type { FacetBrowseConfig } from '../types';
import { useFacetBrowse } from '../hooks/useFacetBrowse';
import { facetValueLabel } from '../utils/format';
import { CSS, themeStyle } from '../styles';
import { FacetRail } from './FacetRail';
import { ResultCard } from './ResultCard';
import { SearchIcon } from './icons';

export type FacetBrowseProps = {
  config: FacetBrowseConfig;
  /** Optional override of the declarative card. Receives one hit. */
  renderCard?: (hit: Record<string, unknown>) => ReactNode;
};

export function FacetBrowse({ config, renderCard }: FacetBrowseProps): JSX.Element {
  const state = useFacetBrowse(config);
  const { result, loading, error, hitsPerPage, page, setPage } = state;

  const hits = result?.hits ?? [];
  const nbHits = result?.nb_hits ?? 0;
  const nbPages = result?.nb_pages ?? 1;

  const themeVars = useMemo(() => themeStyle(config.theme), [config.theme]);

  // Active-filter chips: one per selected facet value + one per active range.
  const chips: Array<{ k: string; v: string; clear: () => void }> = [];
  for (const f of config.facets) {
    (state.selected[f.attr] ?? new Set<string>()).forEach((v) =>
      chips.push({ k: f.label, v: facetValueLabel(f, v), clear: () => state.toggle(f.attr, v) }),
    );
  }
  for (const r of config.ranges ?? []) {
    const range = state.ranges[r.attr];
    if (range && (range.min != null || range.max != null)) {
      const unit = r.unit ? ' ' + r.unit : '';
      chips.push({
        k: r.label,
        v: `${range.min != null ? range.min.toLocaleString() : 'Any'} – ${range.max != null ? range.max.toLocaleString() + unit : 'Any'}`,
        clear: () => state.setRange(r.attr, { min: null, max: null }),
      });
    }
  }

  if (state.ready === false) {
    return (
      <div className="fb" style={themeVars}>
        <style>{CSS}</style>
        <div className="fb-gate">
          <div>
            <h2>{config.title ?? 'Search'}</h2>
            <p>Open this from the Sprigr <b>Apps</b> page so it loads with your account and index.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fb" style={themeVars}>
      <style>{CSS}</style>
      <header>
        <div className="fb-bar">
          <div className="fb-brand">
            <span className="fb-title">{config.title ?? 'Search'}</span>
          </div>
          <div className="fb-searchwrap">
            <SearchIcon />
            <input
              value={state.q}
              onChange={(e) => state.setQ(e.target.value)}
              placeholder={config.searchPlaceholder ?? 'Search…'}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="fb-stat">
            <b>{loading && !result ? '…' : nbHits.toLocaleString()}</b>
            <span>results</span>
          </div>
        </div>
      </header>

      <div className="fb-shell">
        <FacetRail state={state} />

        <main>
          <div className="fb-chips">
            {chips.map((c, i) => (
              <span key={i} className="fb-chip">
                <span className="fb-k">{c.k}:</span> {c.v}{' '}
                <button type="button" onClick={c.clear} aria-label="Remove">
                  ×
                </button>
              </span>
            ))}
            {chips.length > 0 && (
              <button type="button" className="fb-chip fb-clear-all" onClick={state.clearAll}>
                Clear all
              </button>
            )}
          </div>

          <div className="fb-toolbar">
            <div className="fb-result-count">
              {error ? (
                <span className="fb-err">Couldn't search</span>
              ) : (
                <>
                  <b>{nbHits.toLocaleString()}</b> {nbHits === 1 ? 'result' : 'results'}
                </>
              )}
            </div>
            {config.sorts && config.sorts.length > 0 && (
              <div className="fb-sortwrap">
                <label>Sort</label>
                <select value={state.sort} onChange={(e) => state.setSort(e.target.value)}>
                  {config.sorts.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {error ? (
            <div className="fb-empty">
              <h3>Search failed</h3>
              <p>{error}</p>
              <button type="button" onClick={() => void state.runSearch()}>
                Try again
              </button>
            </div>
          ) : loading && !result ? (
            <div className="fb-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="fb-card fb-skeleton" />
              ))}
            </div>
          ) : hits.length === 0 ? (
            <div className="fb-empty">
              <h3>No results match these filters</h3>
              <p>Try widening a range or clearing a filter.</p>
              <button type="button" onClick={state.clearAll}>
                Clear all filters
              </button>
            </div>
          ) : (
            <>
              <div className="fb-grid">
                {hits.map((h, i) =>
                  renderCard ? (
                    <div key={cardKey(h, i)}>{renderCard(h)}</div>
                  ) : (
                    <ResultCard key={cardKey(h, i)} hit={h} card={config.card} />
                  ),
                )}
              </div>
              {nbPages > 1 && (
                <div className="fb-pager">
                  <button type="button" disabled={page <= 0} onClick={() => setPage(Math.max(0, page - 1))}>
                    ← Prev
                  </button>
                  <span className="fb-pageinfo">
                    Page {page + 1} of {nbPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= nbPages - 1}
                    onClick={() => setPage(Math.min(nbPages - 1, page + 1))}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** Stable-ish React key for a hit: objectID/id path when present, else index. */
function cardKey(hit: Record<string, unknown>, i: number): string {
  const id = hit.objectID ?? hit.id ?? hit.source_listing_id;
  return id != null ? String(id) : `hit-${i}`;
}

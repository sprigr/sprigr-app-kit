/** The dark facet rail: one collapsible group per facet with live counts. */
import type { JSX } from 'react';
import type { FacetBrowseState } from '../hooks/useFacetBrowse';
import { facetValueLabel, sortFacetKeys } from '../utils/format';
import { RangeGroup } from './RangeGroup';
import { ChevronIcon, CheckIcon } from './icons';

export function FacetRail({ state }: { state: FacetBrowseState }): JSX.Element {
  const { config, selected, toggle, subq, setSub, collapsed, toggleCollapsed, ranges, setRange, result } = state;
  const facetCounts = result?.facet_counts ?? {};
  return (
    <aside>
      {config.facets.map((f) => {
        const counts = facetCounts[f.attr] ?? {};
        const sel = selected[f.attr] ?? new Set<string>();
        let keys = sortFacetKeys(f, counts, sel);
        const sq = (subq[f.attr] ?? '').toLowerCase();
        if (f.searchable && sq) {
          keys = keys.filter((k) => k.toLowerCase().includes(sq) || sel.has(k));
        }
        const isCol = !!collapsed[f.attr];
        return (
          <div key={f.attr} className={'fb-group' + (isCol ? ' fb-collapsed' : '')}>
            <button className="fb-head" type="button" onClick={() => toggleCollapsed(f.attr)}>
              <span>
                {f.label}
                {sel.size ? ` · ${sel.size}` : ''}
              </span>
              <span className="fb-chev">
                <ChevronIcon />
              </span>
            </button>
            {!isCol && (
              <div className="fb-body">
                {f.searchable && (
                  <input
                    className="fb-subsearch"
                    placeholder={'Find ' + f.label.toLowerCase() + '…'}
                    value={subq[f.attr] ?? ''}
                    onChange={(e) => setSub(f.attr, e.target.value)}
                  />
                )}
                <div className={f.searchable ? 'fb-scroll-list' : ''}>
                  {keys.map((k) => {
                    const c = counts[k] ?? 0;
                    const on = sel.has(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        className={'fb-item' + (c === 0 && !on ? ' fb-disabled' : '')}
                        aria-pressed={on}
                        onClick={() => toggle(f.attr, k)}
                      >
                        <span className="fb-box">
                          <CheckIcon />
                        </span>
                        <span className="fb-lbl">{facetValueLabel(f, k)}</span>
                        <span className="fb-cnt">{c}</span>
                      </button>
                    );
                  })}
                  {keys.length === 0 && <div className="fb-note">No values</div>}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {(config.ranges ?? []).map((r) => (
        <RangeGroup
          key={r.attr}
          label={r.label}
          value={ranges[r.attr] ?? { min: null, max: null }}
          onChange={(next) => setRange(r.attr, next)}
        />
      ))}
    </aside>
  );
}

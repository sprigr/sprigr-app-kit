/**
 * Standalone embed entry for @sprigr/apps-faceted-search.
 *
 * Bundled by scripts/build-embed.mjs into dist/facet-browse.js as a single IIFE
 * that exposes a global `SprigrFacetBrowse` with `mount()` / `unmount()`. Agents
 * building a static website fetch the hosted copy (this repo is private, so raw
 * GitHub URLs do not work) and inline it or reference it directly:
 *
 *   https://sprigr-hq-embeds.sites.sprigr.com/facet-browse/v1/facet-browse.js
 *
 * Then:
 *
 *   <div id="browse"></div>
 *   <script src="facet-browse.js"></script>
 *   <script>
 *     SprigrFacetBrowse.mount('#browse', {
 *       source: { kind: 'searchKey', indexName: '...', apiKey: '...' },
 *       facets: [...], card: {...},
 *     });
 *   </script>
 *
 * react/react-dom are aliased to preact/compat at bundle time, so the whole UI
 * plus renderer is a single self-contained file (the CSS is inlined by the
 * component via a <style> tag, so there is no separate stylesheet to load).
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FacetBrowse } from '../src/components/FacetBrowse';
import type { FacetBrowseConfig } from '../src/types';

const roots = new WeakMap<Element, Root>();

function resolveEl(target: HTMLElement | string): HTMLElement {
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    if (!el) throw new Error(`SprigrFacetBrowse.mount: no element matches "${target}"`);
    return el as HTMLElement;
  }
  return target;
}

/** Mount a FacetBrowse into an element (CSS selector or node). */
export function mount(target: HTMLElement | string, config: FacetBrowseConfig): void {
  const el = resolveEl(target);
  let root = roots.get(el);
  if (!root) {
    root = createRoot(el);
    roots.set(el, root);
  }
  root.render(createElement(FacetBrowse, { config }));
}

/** Unmount a previously-mounted FacetBrowse from an element. */
export function unmount(target: HTMLElement | string): void {
  const el = resolveEl(target);
  const root = roots.get(el);
  if (root) {
    root.unmount();
    roots.delete(el);
  }
}

export type { FacetBrowseConfig };

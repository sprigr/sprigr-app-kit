# Faceted search UI: `@sprigr/apps-faceted-search`

A parameterized faceted-catalog search UI (dark facet rail with live counts, filter chips, numeric ranges, pagination, loading/empty/error states) for two surfaces:

1. **Marketplace app dashboards**: render a catalog backed by the install's private search index, with the query running server-side through one of your app's tools.
2. **Agent-built static websites**: the same UI against a public index with a search-only key, either as a React component or a single-script IIFE embed.

Full reference (config schema, data sources, filter grammar, theming, embed): [packages/faceted-search/README.md](../packages/faceted-search/README.md). This page is the decision guide and the two recipes.

## When to reach for it

Use it whenever a user should browse and filter a catalog of records (listings, products, jobs, documents) instead of asking an agent to search for them. Do not hand-roll a facet rail; the realestate app's was extracted into this package so nobody writes another one.

## Recipe 1: app dashboard over a private index

Your app ingests records into its private index (`env.SPRIGR.data.import` or `collections.*`), declares a search tool, and the UI calls that tool through the platform gateway; the index never becomes public.

1. Exact-pin the dep: `"@sprigr/apps-faceted-search": "0.1.0"` (React >= 18 is a peer).
2. Declare a search tool in the manifest (e.g. `search_listings`) whose handler accepts `{ query, filters, facets, page, hits_per_page }` and returns `{ hits, nb_hits, page, nb_pages, facet_counts? }`. Reference implementation: the realestate app's `search_listings` handler.
3. In your settings/dashboard page:

```tsx
import { FacetBrowse } from '@sprigr/apps-faceted-search';
import type { FacetBrowseConfig } from '@sprigr/apps-faceted-search';

const config: FacetBrowseConfig = {
  source: { kind: 'gateway', toolName: 'search_listings' },
  title: 'Property search',
  facets: [
    { attr: 'status', label: 'Status' },
    { attr: 'suburb', label: 'Suburb', searchable: true },
  ],
  ranges: [{ attr: 'price', label: 'Price' }],
  card: { title: 'address.raw', primary: { attr: 'price', format: 'money' }, href: 'source_url' },
};

export default function Page() {
  return <FacetBrowse config={config} />;
}
```

The gateway source resolves the install from the `#install_id=` URL hash (the iframe embed contract) and auto-detects staging vs prod hosts.

## Recipe 2: static site over a public index

```ts
source: { kind: 'searchKey', indexName: 'my_index', apiKey: 'sk_search_only' }
```

Use a **search-only** key (it is visible in page source, so it must not be an admin key). Host auto-detection routes staging site hostnames to staging search. For plain-HTML sites, the IIFE embed build mounts the same UI with one script tag; see the README's embed section.

## The traps worth knowing before you debug

- **Facet attributes must be in the index's `attributes_for_faceting`.** The engine silently drops filter terms on undeclared attributes; the clause vanishes and results widen. This is the number one "my filter does nothing" cause.
- **Filter values are unquoted** and the grammar is flat CNF (`a:x OR a:y` clauses joined by commas/AND, no parentheses). `buildFilterString` handles this; don't hand-assemble filter strings.
- **`baseFilter`** scopes every query with a fixed expression (e.g. hide tombstones) without showing a chip; it is ANDed with user selections.
- Pin the dep exactly; a version range would roll UI changes into production installs without an app release.

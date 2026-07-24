# @sprigr/apps-faceted-search

A reusable, parameterized faceted-catalog search UI for Sprigr marketplace app
dashboards and agent-built static websites. Point it at a data source, describe
the facets and the card, and render `<FacetBrowse>`.

Polished by default: a dark facet rail with live counts, active-filter chips,
per-facet sub-search, collapsible groups, numeric range inputs (applied on blur
or Enter), loading skeletons, empty/error states, responsive collapse, and real
prev/next pagination. Extracted from the realestate app's SearchApp so every app
stops re-implementing the same catalog UI.

Ships raw TypeScript source (consumed via the `sprigrVendor` pattern) plus a
standalone IIFE embed build for static sites.

## Install (in an app)

Declare the vendor and sync:

```jsonc
// apps/<slug>/package.json
{ "sprigrVendor": ["faceted-search"] }
```

```bash
pnpm sync:vendor
```

Then import from the vendored path (never from `@sprigr/apps-faceted-search`
directly - the build-runner has no workspace context):

```tsx
import { FacetBrowse } from '../lib/vendor/faceted-search';
import type { FacetBrowseConfig } from '../lib/vendor/faceted-search';
```

React is a peer dependency (`react` and, for the embed, `react-dom`).

## Quick start

```tsx
const config: FacetBrowseConfig = {
  source: { kind: 'gateway', toolName: 'search_listings' },
  title: 'Property search',
  searchPlaceholder: 'Search address, suburb, agency…',
  facets: [
    { attr: 'status', label: 'Status', valueLabels: { active: 'For Sale', sold: 'Sold' } },
    { attr: 'bedrooms', label: 'Bedrooms', numeric: true, suffix: 'bed' },
    { attr: 'suburb', label: 'Suburb', searchable: true },
  ],
  ranges: [{ attr: 'price', label: 'Price' }],
  sorts: [
    { value: 'relevance', label: 'Best match' },
    { value: 'price_desc', label: 'Price: high to low' },
  ],
  card: {
    image: 'images.0.url',
    title: 'address.raw',
    subtitle: 'address.suburb',
    primary: { attr: 'price', format: 'money', locale: 'en-AU' },
    badges: [{ attr: 'status', map: { active: { label: 'For sale', tone: 'ok' }, sold: { label: 'Sold', tone: 'err' } } }],
    meta: [{ attr: 'bedrooms', icon: '🛏' }, { attr: 'bathrooms', icon: '🛁' }],
    href: 'source_url',
  },
};

export default function Page() {
  return <FacetBrowse config={config} />;
}
```

Need a bespoke card? Pass `renderCard` to override the declarative one entirely:

```tsx
<FacetBrowse config={config} renderCard={(hit) => <MyCard hit={hit} />} />
```

No photos in your catalog? Omit `card.image` and the card renders compact and
text-first: no image block, no placeholder glyph, no reserved 4:3 area, with
badges inline above the primary line. (When `card.image` IS configured but a
given hit lacks the value, the placeholder block stays so the grid keeps a
uniform rhythm.)

## Data sources

Every source normalizes to the same `SearchResult`
(`{ hits, nb_hits, page, nb_pages, facet_counts? }`), so the UI is source-agnostic.

### `gateway` - marketplace app dashboards

```ts
source: { kind: 'gateway', toolName: 'search_listings', installId? }
```

POSTs `{ args }` to the platform gateway's per-install tool endpoint with
`credentials: 'include'`. The tool runs in dispatch context against the
install's PRIVATE index, so the search stays server-side with no public index.
`installId` defaults from the `#install_id=` URL hash (the iframe embed contract).
Host detection is automatic: a `staging` hostname routes to
`https://staging-api-team.sprigr.com`, otherwise `https://api.team.sprigr.com`.
The tool is expected to accept `{ query, filters, facets, page, hits_per_page }`
and return a `SearchResult`-shaped object (the realestate `search_listings`
handler is the reference).

### `searchKey` - agent-built static websites

```ts
source: { kind: 'searchKey', indexName: 'my_index', apiKey: 'sk_search_only', host? }
```

POSTs to `{host}/1/indexes/{indexName}/query` with the header
`X-Sprigr-API-Key`. When `host` is omitted it auto-detects staging like the
gateway path, resolved per search call: a `staging` page hostname (e.g.
`*.staging-sites.sprigr.com`) routes to `https://staging-search.sprigr.com`,
anything else (including SSR) to `https://search.sprigr.com`. An explicit
`host` always wins. Without this, a site on a staging tenant would query PROD
search with a staging key and get 403 Invalid API key. The request
body is `{ query, filters, facets, page, hits_per_page }`. The raw search API
returns facet counts under `facets`; this adapter normalizes that to
`facet_counts` so both sources feed the UI identically. Use a **search-only**
key - it is visible in the page source.

### `custom` - bring your own

```ts
source: { kind: 'custom', search: (params) => Promise<SearchResult> }
```

Full control: fetch from anywhere, then return a `SearchResult`. This is also
the escape hatch for client-side post-processing (e.g. sorting a returned page).

## Scoping the catalog (`baseFilter`)

Catalogs often need a fixed scoping filter that applies to EVERY query
regardless of user facet selections, e.g. excluding tombstone rows:

```ts
const config: FacetBrowseConfig = {
  // ...
  baseFilter: 'status:qualified OR status:manual_review',
};
```

When set, it is ANDed with the user-assembled filter expression on every
search: if the user filter string is empty, `filters = baseFilter`; otherwise
`filters = "${baseFilter},${userFilters}"` (comma = AND in the engine syntax).
The combination happens in `useFacetBrowse`, before the source call, so all
three sources are scoped identically and facet counts reflect the scoped
catalog. An empty or whitespace-only `baseFilter` is ignored. The base filter
never appears as a chip and `Clear all` does not remove it.

Interaction with user selections: when the user selects values of a facet the
`baseFilter` also constrains, the two are plain-ANDed. A selection inside the
base set (e.g. the `baseFilter` above plus user-selected `status:qualified`)
narrows results as expected, since the AND of the two is satisfiable; a
selection outside the base set yields zero results. No merging or
de-duplication is attempted: plain AND is correct and predictable.

## Filter grammar

The engine parses filters as **flat CNF** (verified against the engine's
`parse_query_filters` in sprigr-search `crates/search-core/src/filter.rs`):

```
expr   := clause ((" AND " | ",") clause)*
clause := term (" OR " term)*
term   := attribute ":" value        (split on the FIRST colon)
```

- **Values are unquoted**: the engine compares the raw substring after the
  first colon, so `status:"active"` (with quotes) matches nothing today.
  `buildFilterString` emits unquoted values; it only quotes a value containing
  a separator substring (`" OR "`, `" AND "`, or a comma), which is rare and
  only starts matching once the engine's quote/paren tolerance change deploys.
- **No parentheses**: OR binds tighter than the comma/AND conjunction, so a
  multi-value clause is emitted flat (`status:active OR status:sold`). A
  parenthesized group would be silently dropped (the `(status` attribute is
  unknown).
- **Ranges** (`price:100 TO 500`) are emitted for range inputs but are not yet
  supported by the engine; they no-op or zero-match until the in-flight engine
  change adding range support deploys, then start working with no change here.
- **Attributes must be declared in the index's `attributes_for_faceting`**:
  the engine SILENTLY drops any term whose attribute is not on that list (the
  clause vanishes and results widen). This is the number one silent failure
  when a filter appears to do nothing; check the index settings first.

## Theming

All CSS custom properties are prefixed `--fb-` to avoid colliding with the host
page. Defaults are a warm-neutral + lime palette; override any of them via
`config.theme`:

```ts
theme: { '--fb-accent': '#4fc3f7', '--fb-accent-deep': '#0277bd' }
```

Overridable tokens include `--fb-ground`, `--fb-surface`, `--fb-ink`,
`--fb-muted`, `--fb-line`, the dark-rail set (`--fb-rail`, `--fb-rail-2`,
`--fb-rail-ink`, `--fb-rail-muted`, `--fb-rail-line`), `--fb-accent`,
`--fb-accent-deep`, the badge tones (`--fb-ok`, `--fb-warn`, `--fb-err`,
`--fb-neutral`), `--fb-radius`, and `--fb-shadow`. See `DEFAULT_THEME` in
`src/styles.ts` for the full list and values. This is a tenant-facing surface,
so it deliberately carries no Sprigr lockup or brand marks.

## Standalone embed (static sites)

For a plain HTML site with no build step, use the hosted bundle:

```
https://sprigr-hq-embeds.sites.sprigr.com/facet-browse/v1/facet-browse.js
```

(This repo is private, so raw GitHub URLs do not work for agents; the bundle is
published to a Sprigr-owned static site on the prod platform instead. The
committed copy at `dist/facet-browse.js` is the source of truth for what gets
published.) It is a single IIFE (react/react-dom bundled as preact/compat) that
exposes a global `SprigrFacetBrowse`. The CSS is injected by the component via a
`<style>` tag, so there is no separate stylesheet to load.

```html
<div id="browse"></div>
<script src="https://sprigr-hq-embeds.sites.sprigr.com/facet-browse/v1/facet-browse.js"></script>
<script>
  SprigrFacetBrowse.mount('#browse', {
    source: { kind: 'searchKey', indexName: 'my_index', apiKey: 'sk_search_only' },
    facets: [{ attr: 'brand', label: 'Brand', searchable: true }],
    card: { title: 'title', primary: { attr: 'price', format: 'money' } },
  });
  // SprigrFacetBrowse.unmount('#browse');  // to tear down
</script>
```

An agent building a static site can also fetch that URL at build time and
inline the contents. See `examples/embed.html` for a full config (not served
anywhere; it exists for local eyeballing + the DOM smoke test).

### Rebuilding the bundle

```bash
pnpm --filter @sprigr/apps-faceted-search build:embed   # rebuild dist/
pnpm --filter @sprigr/apps-faceted-search check:embed   # CI gate: fail if stale
```

`check:embed` mirrors `sync:vendor:check` - it rebuilds to a buffer and diffs
against the committed file, exiting non-zero on drift. Commit the rebuilt
`dist/facet-browse.js` whenever you change the package source.

### Releasing the hosted embed

Publishing to the hosted site is a manual operator step (CI has no platform
credentials, so it is deliberately not wired into any workflow):

```bash
# with a CLI login profile from ~/.config/sprigr/credentials/<name>.json
pnpm --filter @sprigr/apps-faceted-search publish:embed -- --profile prod

# or with explicit env vars
SPRIGR_API_KEY=sk_mcp_... pnpm --filter @sprigr/apps-faceted-search publish:embed
```

The script (`scripts/publish-embed.mjs`) verifies `dist/facet-browse.js` is
fresh (same check as `check:embed`), assembles a static site (an `index.html`
directory page listing each embed with its version and sha256, plus
`facet-browse/v1/facet-browse.js`), and deploys it to the embeds site via the
platform build API (start-build then poll, the same flow as `sprigr deploy`).
`SPRIGR_EMBEDS_SITE_ID` overrides the target site; `--dry-run` lists the files
without deploying; `--keep-dir` keeps the assembled temp dir for inspection.

Versioning policy: the `v1` path is updated **in place** for compatible changes
(rebuild dist, commit, run `publish:embed`). A breaking change to the config
contract ships under a new path (`/facet-browse/v2/`) so existing static sites
keep working; add the new path to the publish script alongside `v1` when that
day comes.

## Public API

- `<FacetBrowse config renderCard? />` - the component.
- `useFacetBrowse(config)` - the state + fetch hook, if you want a custom shell.
- `resolveSource`, `gatewaySearch`, `searchKeySearch`, `readInstallId`,
  `invokeTool`, `normalizeSearchKeyResponse` - source helpers.
- `buildFilterString`, `combineFilters`, `resolvePath`, `formatPrimary`, `sortFacetKeys` - utils.
- `CSS`, `DEFAULT_THEME`, `themeStyle` - styling.

Types: `FacetBrowseConfig`, `FacetBrowseSource`, `SearchParams`, `SearchResult`,
`FacetConfig`, `RangeConfig`, `SortConfig`, `CardConfig`, and friends. The config
shape is the fixed public contract - see `src/types.ts`.

## Tests

```bash
pnpm --filter @sprigr/apps-faceted-search test
```

Covers filter-string assembly, dot-path resolution, both source adapters (mocked
fetch), facet sort orders, searchKey response normalization, and a jsdom smoke
test that mounts the UI end-to-end.

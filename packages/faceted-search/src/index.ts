/**
 * @sprigr/apps-faceted-search
 *
 * A reusable, parameterized faceted-catalog search UI: dark facet rail with
 * live counts, chips, sub-search, range filters, pagination, skeletons, and
 * empty/error states. Point it at a data source (gateway tool, search key, or a
 * custom function), describe the facets and the card, and render <FacetBrowse>.
 *
 * Ships raw TS source for the sprigrVendor pattern. For a plain static site,
 * use the standalone embed build (see ./embed and packages/faceted-search/dist).
 */
export { FacetBrowse } from './components/FacetBrowse';
export type { FacetBrowseProps } from './components/FacetBrowse';
export { ResultCard } from './components/ResultCard';
export { useFacetBrowse } from './hooks/useFacetBrowse';
export type { FacetBrowseState } from './hooks/useFacetBrowse';

export { CSS, DEFAULT_THEME, themeStyle } from './styles';

export { buildFilterString, combineFilters, escapeFilterValue } from './utils/filters';
export type { RangeState } from './utils/filters';
export { resolvePath, resolveString, resolveNumber } from './utils/path';
export { formatPrimary, capitalizeWords, facetValueLabel, sortFacetKeys } from './utils/format';

export {
  resolveSource,
  sourceReady,
  gatewaySearch,
  gatewayBase,
  readInstallId,
  invokeTool,
  searchKeySearch,
  normalizeSearchKeyResponse,
  DEFAULT_SEARCH_HOST,
  defaultSearchHost,
} from './sources';
export type { SearchFn } from './sources';

export type {
  FacetBrowseConfig,
  FacetBrowseSource,
  SearchParams,
  SearchResult,
  FacetConfig,
  RangeConfig,
  SortConfig,
  CardConfig,
  CardPrimary,
  CardBadge,
  CardMeta,
  BadgeTone,
} from './types';

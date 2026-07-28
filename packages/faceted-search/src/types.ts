/**
 * Public type contract for @sprigr/apps-faceted-search.
 *
 * This is the FIXED public API. The platform docs and consuming apps are
 * written against these shapes, so treat every field here as load-bearing.
 */

/** Parameters passed to a data source's search call. */
export type SearchParams = {
  query: string;
  filters?: string;
  facets: string[];
  page: number;
  hitsPerPage: number;
  /**
   * The currently-selected sort option's `value` (from SortConfig), or
   * undefined for the default. The searchKey source forwards this as the
   * engine's `sort_by`; the gateway source forwards it as `sort`; a custom
   * source may interpret it however it likes (e.g. client-side sorting).
   */
  sort?: string;
};

/**
 * Normalized search result the UI renders. Every source adapter maps its
 * raw response into this shape. Facet counts are keyed attr -> value -> count.
 */
export type SearchResult = {
  hits: Record<string, unknown>[];
  nb_hits: number;
  page: number;
  nb_pages: number;
  facet_counts?: Record<string, Record<string, number>>;
};

/**
 * Where the browse UI gets its data.
 *
 * - `gateway`: POST to the platform gateway's per-install tool endpoint. This
 *   is the marketplace-app-dashboard path (the SearchApp.tsx pattern). The
 *   install id defaults from the `#install_id=` URL hash.
 * - `searchKey`: POST directly to the Sprigr search API with a search-only
 *   API key. This is the agent-built-static-website path. When host is
 *   omitted it auto-detects staging like the gateway path: a staging page
 *   hostname routes to https://staging-search.sprigr.com, anything else to
 *   https://search.sprigr.com. An explicit host always wins.
 * - `custom`: bring your own async search function returning a SearchResult.
 */
export type FacetBrowseSource =
  | { kind: 'gateway'; toolName: string; installId?: string }
  | { kind: 'searchKey'; indexName: string; apiKey: string; host?: string }
  | { kind: 'custom'; search: (params: SearchParams) => Promise<SearchResult> };

/** One facet in the filter rail. */
export type FacetConfig = {
  attr: string;
  label: string;
  /** Numeric facets sort ascending by value; categorical sort by count desc. */
  numeric?: boolean;
  /** Unit word appended after a numeric value, e.g. "bed" -> "3 beds". */
  suffix?: string;
  /** Show a sub-search input to filter the facet's own values. */
  searchable?: boolean;
  /** Start the group collapsed. */
  collapsed?: boolean;
  /** Map raw facet values to display labels, e.g. { active: 'For Sale' }. */
  valueLabels?: Record<string, string>;
};

/** One numeric range filter (min/max inputs applied on blur/Enter). */
export type RangeConfig = {
  attr: string;
  label: string;
  /** Unit suffix shown in the active-filter chip, e.g. "m²". */
  unit?: string;
};

/** One sort option in the toolbar dropdown. */
export type SortConfig = { value: string; label: string };

/** Tone for a badge pill. */
export type BadgeTone = 'ok' | 'warn' | 'err' | 'neutral';

/** How to format the card's primary line (usually a price). */
export type CardPrimary = {
  attr: string;
  format?: 'money' | 'number' | 'text';
  /** Intl locale, e.g. 'en-AU'. Defaults to the browser default. */
  locale?: string;
  /** ISO currency code. When set with format 'money', uses currency style. */
  currency?: string;
};

/** A status/label pill on the card image. */
export type CardBadge = {
  attr: string;
  map?: Record<string, { label: string; tone?: BadgeTone }>;
};

/** One item in the card's spec/meta row. */
export type CardMeta = {
  attr: string;
  label?: string;
  suffix?: string;
  /** Emoji or short glyph shown before the value. */
  icon?: string;
};

/** Declarative card layout. dot-paths index into a hit (e.g. 'images.0.url'). */
export type CardConfig = {
  /**
   * Dot-path to the hit's image URL. When omitted, the card renders compact
   * and text-first with no image block at all (no placeholder glyph, no
   * reserved 4:3 area); badges move inline above the primary line. When
   * configured but a given hit lacks the value, the 4:3 block stays with the
   * placeholder glyph so the grid keeps a uniform rhythm.
   */
  image?: string;
  title: string;
  subtitle?: string;
  primary?: CardPrimary;
  badges?: CardBadge[];
  meta?: CardMeta[];
  href?: string;
  /** Optional action buttons rendered at the foot of each card. */
  actions?: Array<{
    /** Value passed to onCardAction. */
    value: string;
    label: string;
    tone?: 'ok' | 'warn' | 'err' | 'neutral';
  }>;
};

/** Full configuration for a <FacetBrowse> instance. */
export type FacetBrowseConfig = {
  source: FacetBrowseSource;
  title?: string;
  searchPlaceholder?: string;
  facets: FacetConfig[];
  ranges?: RangeConfig[];
  sorts?: SortConfig[];
  card: CardConfig;
  hitsPerPage?: number;
  /**
   * Fixed scoping filter ANDed with the user-assembled filter expression on
   * EVERY search, regardless of facet selections. Use it to pin the catalog,
   * e.g. excluding tombstone rows: `'status:qualified OR status:manual_review'`.
   *
   * When the user filter string is empty, `filters = baseFilter`; otherwise
   * `filters = "${baseFilter},${userFilters}"` (comma = AND in the engine
   * syntax). Facet counts therefore reflect the scoped catalog.
   *
   * Interaction note: when the user selects values of a facet the baseFilter
   * also constrains, the two are plain-ANDed. A user selection inside the
   * base set (e.g. baseFilter `status:qualified OR status:manual_review`
   * plus user-selected `status:qualified`) narrows results as expected; a
   * selection outside the base set yields zero results. No de-duplication or
   * merging is attempted: plain AND is correct and predictable.
   */
  baseFilter?: string;
  /** CSS custom property overrides, e.g. { '--fb-accent': '#B9D94B' }. */
  theme?: Record<string, string>;
  /**
   * Invoked when a card action button is clicked. Receives the full hit and
   * the action's `value`. May be async; the card shows a pending state while
   * it settles and surfaces a failure inline.
   */
  onCardAction?: (hit: Record<string, unknown>, value: string) => void | Promise<void>;
};

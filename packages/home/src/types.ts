/**
 * Home Contracts: the shapes apps and the platform exchange (FINAL-APP-FEEDS
 * sections 3.1, 3.2 and 4). Types only; the runtime rules are in
 * `records.ts` (answers) and `manifest.ts` (the manifest `home` block).
 *
 * Self-contained, so it lifts into `@sprigr/apps-home` unchanged (see
 * vocabulary.ts).
 */

import type {
  HomeAudience,
  HomeContractId,
  HomeDetailType,
  HomeIdentityMethod,
  HomePersonLinkMethod,
  HomeProviderContractId,
  HomePurpose,
  HomeRole,
  HomeScope,
  HomeState,
  IdentityConnection,
  MetricCompareBasis,
  MetricId,
  QueueReason,
  QueueSeverity,
  QueueWhy,
  ScheduleCategory,
  ScheduleKind,
  ScheduleStatus,
  SubjectFact,
  SubjectFactMode,
  SubjectKey,
} from './vocabulary';

/** UTC instant, always with a Z suffix (the fulfilment hub rule): '2026-10-06T21:30:00Z'. */
export type Instant = string;
/** Local calendar date in `basis.tz`: '2026-10-07'. */
export type LocalDay = string;

// ─── The request and the answer ────────────────────────────────────────────

/**
 * Built only by the platform, from platform values and static manifest args.
 * It reaches the app as `args._home`, which the wrapper rebuilds from the
 * platform-only `x-sprigr-home-request` header (slice 2a-3, decision 0177) on
 * a Home dispatch to the app's Home tool, deleting any body copy; an app never
 * trusts a body copy.
 */
export interface HomeRequest {
  contract: HomeContractId;
  /** Highest version the platform renders, e.g. '1.2.0'. */
  version: string;
  /** The manifest `provides[].id` (or the identity provider id). */
  provider: string;
  scope: HomeScope;
  basis: { day: LocalDay; tz: string; window_start: Instant; window_end: Instant };
  person?: { vendor_person_id: string; method: HomePersonLinkMethod };
  /** subject_facts and detail only; `ref` is THIS app's id. */
  mode?: { kind: 'bulk' } | { kind: 'ref'; ref: string };
  purpose: HomePurpose;
  /** 3500: answer before the platform's 4000 ms cut. */
  deadline_ms: number;
}

export interface HomeResult<R> {
  /** Version actually used; must be <= request.version. */
  v: string;
  state: HomeState;
  /** When the data was true at the vendor; clamped to <= platform now on receipt. */
  as_of: Instant;
  /** May only SHORTEN the declared TTL, never lengthen it. */
  stale_after?: Instant;
  /** Timeline hint, e.g. the next booking start. */
  next_refresh_at?: Instant;
  /** Echo of the request basis; a mismatch is refused as 'error'. */
  basis: { day: LocalDay; tz: string };
  /** Per-contract cap (HOME_RECORD_CAPS). Empty unless state is 'ok'. */
  records: R[];
  truncated?: { at_least: number };
  /** rate_limited only. */
  retry_after_s?: number;
}

export interface Ref {
  /** The app's own stable record id, <= 128 chars. */
  id: string;
  /** The human number, <= 32 chars: 'INV-0042', 'Job 1182'. */
  label?: string;
  /** A manifest `home.links[].id`; the platform fills the template with `id`. */
  link?: string;
}

/** A join key. `issuer` is the app slug that minted a `*_ref` (required for those). */
export interface Subject {
  key: SubjectKey;
  value: string;
  issuer?: string;
}

/** At most 4 per record, shown in the hover card as "From <app>". */
export interface DetailField {
  /** <= 24 chars. */
  label: string;
  value: string | number;
  type: HomeDetailType;
}

/** Integer minor units, ISO 4217 currency. */
export interface Money {
  minor: number;
  currency: string;
}

// ─── Record kinds (3.2) ────────────────────────────────────────────────────

/** sprigr/home_schedule 1.0.0: at most 200 records. */
export interface ScheduleRecord {
  /** Required, stable across refreshes. */
  id: string;
  /** window = "arrive 8 to 12". */
  kind: ScheduleKind;
  /** Required unless all_day. */
  start?: Instant;
  /** Required for block and window. */
  end?: Instant;
  /** Required for all_day. */
  day?: LocalDay;
  /** vendor_person_id; required when scope = 'crew'. */
  person?: string;
  status: ScheduleStatus;
  category: ScheduleCategory;
  /** <= 80, plain text. */
  title: string;
  /** <= 160, tagged pii. */
  location?: { text: string };
  /** <= 4 join keys, never rendered. */
  subjects?: Subject[];
  /** Exact de-dup against calendar copies. */
  same_as?: { ical_uid?: string };
  /** When the vendor's zone differs from basis.tz. */
  vendor_tz?: string;
  ref: Ref;
  detail?: DetailField[];
}

/** sprigr/home_queue 1.0.0: at most 50 records. The app gives a reason, never a rank. */
export interface QueueRecord {
  id: string;
  reason: QueueReason;
  why: QueueWhy;
  /** reason = 'broken' only. */
  severity?: QueueSeverity;
  /** <= 80. */
  title: string;
  /** Display and checks only; ranking uses the platform's first-seen time (8.2). */
  waiting_since?: Instant;
  due_at?: Instant;
  /** Required when reason = 'expires'. */
  expires_at?: Instant;
  /** Grouped row: "5 bills to approve". */
  count?: number;
  subjects?: Subject[];
  ref: Ref;
}

export type MetricValue = { kind: 'money'; amount: Money } | { kind: 'count'; n: number };

export type MetricPeriod =
  | { kind: 'instant' }
  | { kind: 'day'; day: LocalDay }
  | { kind: 'range'; from: LocalDay; to: LocalDay }
  | { kind: 'all_time' };

/** sprigr/home_metrics 1.0.0: at most 12 records. */
export interface MetricRecord {
  metric: MetricId;
  value: MetricValue;
  /** "2 invoices" beside a money value. */
  count?: number;
  /** A floor: "at least 6 jobs". */
  at_least?: boolean;
  period: MetricPeriod;
  compare?: { basis: MetricCompareBasis; value: MetricValue };
  /** <= 30 points, Sparkline only. */
  series?: number[];
  ref?: Ref;
}

/** sprigr/home_subject_facts 1.0.0: bulk mode <= 500 records; ref mode <= 20. */
export interface SubjectFactRecord {
  id: string;
  /** Required, 1 to 4. */
  subjects: Subject[];
  fact: SubjectFact;
  date?: LocalDay;
  amount?: Money;
  /** <= 160, last_visit_note only, tagged free_text. */
  text?: string;
  ref: Ref;
}

export interface IdentityPerson {
  vendor_person_id: string;
  display_name: string;
  /** Used for matching, then dropped by the platform (7.2). */
  email?: string;
  active: boolean;
}

/** sprigr/home_identity 1.0.0: a status read; never mints anything. */
export interface IdentityRecord {
  connection: IdentityConnection;
  /** The vendor's "who am I". */
  native_person?: { vendor_person_id: string; display_name: string };
  /** <= 500. */
  people?: IdentityPerson[];
}

/** The record type each contract answers with. */
export interface HomeRecordByContract {
  'sprigr/home_schedule': ScheduleRecord;
  'sprigr/home_queue': QueueRecord;
  'sprigr/home_metrics': MetricRecord;
  'sprigr/home_subject_facts': SubjectFactRecord;
  'sprigr/home_identity': IdentityRecord;
}

/**
 * Platform-stamped provenance around a validated answer, stored in the cache.
 * The platform caches it per viewer (owner key `u:<id>`, or `co` for a
 * company-audience provider) in CACHE_KV, and HomeCoordinatorDO holds the
 * generations that decide whether a copy is still current (slice 2a-2,
 * decisions 0173 and 0174). The app cannot write it; it is the only source of
 * every "ServiceM8 · as of 07:12" line. Declared here so the platform and the
 * SDK agree on its shape.
 */
export interface HomeEnvelope<R> {
  install_id: string;
  app_slug: string;
  provider_id: string;
  contract: HomeContractId;
  /** The pinned manifest version that answered. */
  version_id: string;
  /** Who this copy belongs to. */
  owner_key: `u:${string}` | 'co';
  /** Hash of the vendor_person_id the request carried. */
  person_link?: string;
  /** Platform clock. */
  received_at: Instant;
  delivery: 'pull' | 'prime';
  gen: { provider: number; owner: number };
  /** Validated, sanitized, subjects replaced by hashes. */
  result: HomeResult<R>;
}

// ─── The manifest `home` block (section 4) ─────────────────────────────────

/** An app page (`/jobs/{ref}`) or an https URL on a declared link host. Exactly one `{ref}`. */
export type HomeLinkDeclaration =
  | { id: string; page: string; opens_in: string }
  | { id: string; url: string; opens_in: string };

export interface HomeIdentityDeclaration {
  contract: 'sprigr/home_identity';
  version: string;
  /** The identity provider id the platform passes as `HomeRequest.provider`. */
  provider: string;
  methods: HomeIdentityMethod[];
}

export interface HomeRateDeclaration {
  /** A label inside the app; the coordinator keys counters by `{app_slug}:{install_id}:{group}`. */
  group: string;
  /** 1 to 60. */
  max_dispatches_per_minute: number;
}

export interface HomeProviderDeclaration {
  /** Unique, `^[a-z][a-z0-9_]{1,31}$`. */
  id: string;
  contract: HomeProviderContractId;
  /** A requirement the platform serves: `^1.0`. */
  version: string;
  scope: HomeScope;
  audience: HomeAudience;
  roles: HomeRole[];
  requires_person?: boolean;
  /** 60 to 3600. The app's `stale_after` may only shorten it. */
  ttl_seconds: number;
  /** A JSON file in the upload: a list of `{ name, request, vendor?, expect }` cases. */
  fixtures: string;
  /** home_metrics only. */
  metrics?: MetricId[];
  /** home_subject_facts only. */
  facts?: SubjectFact[];
  /** home_subject_facts only. */
  modes?: SubjectFactMode[];
  /** home_queue only. */
  reasons?: QueueReason[];
  /** home_queue only. */
  whys?: QueueWhy[];
}

/** The closed `home` block of an app manifest. */
export interface HomeBlock {
  /** The ONE read-only routed tool: `get_<slug_underscored>_home`, `internal: true`. */
  tool: string;
  links?: HomeLinkDeclaration[];
  /** At most 4 exact hostnames an https link may open. Separate from egress. */
  link_hosts?: string[];
  identity?: HomeIdentityDeclaration;
  rate: HomeRateDeclaration;
  provides: HomeProviderDeclaration[];
}

/** One case in a provider's fixtures file. */
export interface HomeFixtureCase<R = unknown> {
  name: string;
  request: HomeRequest;
  /** What the vendor returns in this case; opaque to the platform. */
  vendor?: unknown;
  expect: HomeResult<R>;
}

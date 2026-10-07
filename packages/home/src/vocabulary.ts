/**
 * Home Contracts: the closed vocabularies, the served contract versions and
 * the semver helpers (FINAL-APP-FEEDS sections 3.1 to 3.3).
 *
 * Every closed set is declared once, here, as an `as const` array, and the
 * matching TypeScript type is derived from it (the decision 0027 discipline).
 * The manifest validator, the record validator and the generated JSON schemas
 * all read these arrays, so they cannot disagree.
 *
 * Self-contained on purpose: this directory imports nothing from outside
 * itself, so it can be lifted into the NEW `@sprigr/apps-home` npm package
 * unchanged. Where a rule mirrors a platform rule that lives elsewhere in
 * `@sprigr/team-shared` (the interface semver grammar, the join-hint list), a
 * drift test in packages/shared/__tests__ compares the two.
 *
 * vocabulary.ts, types.ts and manifest.ts are also copied into
 * apps/cli/src/home-contracts/, because the published CLI cannot import this
 * unpublished workspace package. apps/cli/__tests__/home-contracts-drift.test.ts
 * fails when a copy differs in anything but its `.js` import suffixes: edit
 * here, then copy.
 *
 * Versioning (3.3): additive minors only. A minor may add optional fields or
 * vocabulary entries; removing, renaming, narrowing or making a field required
 * needs a new major. The platform ships a version before any manifest may
 * require it. One vocabulary entry plus one fixture per PR. No deprecation
 * machinery in v1.
 */

// ─── Contracts and versions ────────────────────────────────────────────────

/** The namespace every Home contract lives in. The app slug `sprigr` is
 *  reserved for the platform (PLATFORM_RESERVED_APP_SLUGS, #10419), so no
 *  publisher can define an interface under it. */
export const HOME_CONTRACT_NAMESPACE = 'sprigr' as const;

/** The five platform-owned contracts. Alerts are queue records with
 *  `reason: 'broken'`, not a sixth contract. */
export const HOME_CONTRACT_IDS = [
  'sprigr/home_schedule',
  'sprigr/home_queue',
  'sprigr/home_metrics',
  'sprigr/home_subject_facts',
  'sprigr/home_identity',
] as const;
export type HomeContractId = (typeof HOME_CONTRACT_IDS)[number];

/** The contracts a `home.provides[]` entry may name. Identity is declared in
 *  `home.identity`, never as a provider. */
export const HOME_PROVIDER_CONTRACT_IDS = [
  'sprigr/home_schedule',
  'sprigr/home_queue',
  'sprigr/home_metrics',
  'sprigr/home_subject_facts',
] as const satisfies readonly HomeContractId[];
export type HomeProviderContractId = (typeof HOME_PROVIDER_CONTRACT_IDS)[number];

/** The identity contract, declared once per app in `home.identity`. */
export const HOME_IDENTITY_CONTRACT_ID = 'sprigr/home_identity' as const satisfies HomeContractId;

/**
 * Every version the platform serves, per contract, oldest first. A manifest
 * may require only a version listed here (3.3 rule 3: the platform ships
 * first). A NEW minor is added here in the same PR as its vocabulary entry,
 * its renderer and its fixture.
 */
export const HOME_CONTRACT_SERVED_VERSIONS: Readonly<Record<HomeContractId, readonly string[]>> = {
  'sprigr/home_schedule': ['1.0.0'],
  'sprigr/home_queue': ['1.0.0'],
  'sprigr/home_metrics': ['1.0.0'],
  'sprigr/home_subject_facts': ['1.0.0'],
  'sprigr/home_identity': ['1.0.0'],
};

/** Mirrors INTERFACE_VERSION_REGEX (decision 0077): strict MAJOR.MINOR.PATCH. */
export const HOME_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Mirrors INTERFACE_VERSION_REQUIREMENT_REGEX (decision 0077): `^1`, `^1.2`,
 *  `^1.2.3`, or an exact `1.2.3`. */
export const HOME_VERSION_REQUIREMENT_REGEX =
  /^(\^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,2}|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;

function parseSemver(v: string): [number, number, number] | null {
  const m = HOME_SEMVER_REGEX.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when a < b, positive when a > b, 0 when equal or unparseable. */
export function compareHomeVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Does `version` satisfy `requirement`? Same rule as the 0077 registry's
 * `interfaceVersionSatisfies`: `^X[.Y[.Z]]` is the same major and at least
 * that minor and patch; a bare `X.Y.Z` is exactly that version.
 */
export function homeVersionSatisfies(version: string, requirement: string): boolean {
  const p = parseSemver(version);
  if (!p) return false;
  if (!HOME_VERSION_REQUIREMENT_REGEX.test(requirement)) return false;
  if (!requirement.startsWith('^')) {
    const r = parseSemver(requirement);
    return !!r && r[0] === p[0] && r[1] === p[1] && r[2] === p[2];
  }
  const parts = requirement.slice(1).split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (p[0] !== major) return false;
  if (p[1] !== minor) return p[1] > minor;
  return p[2] >= patch;
}

/**
 * The lowest served version of `contract` that satisfies `requirement`, or
 * null when none does. A manifest's declared vocabulary is checked at this
 * version: an app that names a metric added in 1.1 must require `^1.1`.
 */
export function homeBaselineVersion(contract: HomeContractId, requirement: string): string | null {
  for (const v of HOME_CONTRACT_SERVED_VERSIONS[contract]) {
    if (homeVersionSatisfies(v, requirement)) return v;
  }
  return null;
}

/** The highest version the platform serves for `contract`: what a request carries. */
export function homeLatestServedVersion(contract: HomeContractId): string {
  const served = HOME_CONTRACT_SERVED_VERSIONS[contract];
  return served[served.length - 1] ?? '1.0.0';
}

export function isHomeContractId(v: unknown): v is HomeContractId {
  return typeof v === 'string' && (HOME_CONTRACT_IDS as readonly string[]).includes(v);
}

/** True for any id in the Home namespace, served or not (`sprigr/home_*`). */
export function isHomeNamespaceId(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(`${HOME_CONTRACT_NAMESPACE}/home_`);
}

// ─── Who is asking ─────────────────────────────────────────────────────────

/** Company roles as the platform stores them (memberships.role, migration 0001;
 *  apps/portal/src/lib/auth.ts). */
export const HOME_ROLES = ['owner', 'admin', 'manager', 'member'] as const;
export type HomeRole = (typeof HOME_ROLES)[number];

/** Roles a `scope: 'crew'` provider may be shown to (4.3 rule 5). */
export const HOME_CREW_ROLES = ['owner', 'admin', 'manager'] as const satisfies readonly HomeRole[];

/** Whose data a provider answers about. */
export const HOME_SCOPES = ['me', 'crew', 'company'] as const;
export type HomeScope = (typeof HOME_SCOPES)[number];

/** Who the platform stamps as actor, and whose cache the answer lands in (7.1). */
export const HOME_AUDIENCES = ['per_user', 'company'] as const;
export type HomeAudience = (typeof HOME_AUDIENCES)[number];

/** Why the platform is dispatching. `read` covers a view, a refetch and an agent read alike. */
export const HOME_PURPOSES = ['read', 'precompute', 'detail', 'identity', 'preview'] as const;
export type HomePurpose = (typeof HOME_PURPOSES)[number];

/** The state of one answer. */
export const HOME_STATES = [
  'ok', 'empty', 'not_connected', 'colleague_only', 'unmapped', 'rate_limited', 'error',
] as const;
export type HomeState = (typeof HOME_STATES)[number];

/** How the viewer's vendor person was found (7.2), as carried on a request. */
export const HOME_PERSON_LINK_METHODS = ['native', 'email_match', 'single_person', 'picked'] as const;
export type HomePersonLinkMethod = (typeof HOME_PERSON_LINK_METHODS)[number];

/** The matching methods an app's identity provider supports, as declared in the manifest. */
export const HOME_IDENTITY_METHODS = ['native', 'email_match', 'picker'] as const;
export type HomeIdentityMethod = (typeof HOME_IDENTITY_METHODS)[number];

// ─── Shared value vocabularies ─────────────────────────────────────────────

/**
 * Join keys a record may carry. A SUBSET of the platform's join-hint
 * vocabulary (CONTRACT_JOIN_HINTS, decision 0030), never a parallel list: a
 * drift test asserts every entry here is in that list. `abn`, `invoice_ref`
 * and `job_ref` joined CONTRACT_JOIN_HINTS first, one entry plus one fixture
 * each, so 1.0.0 carries all six FINAL-APP-FEEDS 3.1 lists. A `*_ref` is exact
 * and paired with its `issuer`; an `abn` is 11 digits that pass the ABN
 * checksum (8.4). `phone_e164` follows in Phase 3, after the normalizer.
 */
export const HOME_SUBJECT_KEYS = ['email', 'order_ref', 'customer_ref', 'abn', 'invoice_ref', 'job_ref'] as const;
export type SubjectKey = (typeof HOME_SUBJECT_KEYS)[number];

/** How a detail value is typed for display. */
export const HOME_DETAIL_TYPES = ['string', 'number', 'date', 'money'] as const;
export type HomeDetailType = (typeof HOME_DETAIL_TYPES)[number];

/** The decision 0030 sensitivity vocabulary, as the platform tags record fields. */
export const HOME_SENSITIVITY_TAGS = ['pii', 'financial_cost', 'contact', 'free_text'] as const;
export type HomeSensitivityTag = (typeof HOME_SENSITIVITY_TAGS)[number];

// ─── sprigr/home_schedule ──────────────────────────────────────────────────

export const HOME_SCHEDULE_KINDS = ['block', 'window', 'deadline', 'all_day'] as const;
export type ScheduleKind = (typeof HOME_SCHEDULE_KINDS)[number];

export const HOME_SCHEDULE_STATUSES = ['tentative', 'scheduled', 'en_route', 'started', 'done', 'cancelled'] as const;
export type ScheduleStatus = (typeof HOME_SCHEDULE_STATUSES)[number];

export const HOME_SCHEDULE_CATEGORIES = ['job', 'meeting', 'task', 'delivery', 'inspection', 'other'] as const;
export type ScheduleCategory = (typeof HOME_SCHEDULE_CATEGORIES)[number];

// ─── sprigr/home_queue ─────────────────────────────────────────────────────

/** The app gives a reason, never a rank; the platform assigns the tier (8.2). */
export const HOME_QUEUE_REASONS = [
  'expires', 'customer_waiting', 'colleague_waiting', 'broken', 'assigned', 'due', 'fyi',
] as const;
export type QueueReason = (typeof HOME_QUEUE_REASONS)[number];

export const HOME_QUEUE_WHYS = [
  'quote_expires', 'enquiry_new', 'ticket_unanswered', 'bill_awaiting_approval',
  'order_unfulfilled', 'task_due', 'approval_requested',
  'sync_broken', 'connection_expiring', 'exception', 'stock_out', 'sla_breach', 'delivery_failed',
] as const;
export type QueueWhy = (typeof HOME_QUEUE_WHYS)[number];

/** Only on `reason: 'broken'`. */
export const HOME_QUEUE_SEVERITIES = ['warn', 'critical'] as const;
export type QueueSeverity = (typeof HOME_QUEUE_SEVERITIES)[number];

// ─── sprigr/home_metrics ───────────────────────────────────────────────────

/** No metric enters this list without a renderer (3.3 rule 4). */
export const HOME_METRIC_IDS = [
  'receivables.overdue', 'receivables.outstanding', 'payables.to_approve', 'payables.due_7d',
  'cash.bank_balance', 'sales.day', 'sales.mtd', 'orders.unfulfilled',
  'jobs.completed_unpaid', 'jobs.completed_not_invoiced', 'quotes.to_send',
  'tickets.open_mine', 'exceptions.open', 'stock.low', 'crew.on_job',
] as const;
export type MetricId = (typeof HOME_METRIC_IDS)[number];

export const HOME_METRIC_VALUE_KINDS = ['money', 'count'] as const;
export const HOME_METRIC_PERIOD_KINDS = ['instant', 'day', 'range', 'all_time'] as const;
export const HOME_METRIC_COMPARE_BASES = ['same_weekday_last_week', 'yesterday', 'last_month'] as const;
export type MetricCompareBasis = (typeof HOME_METRIC_COMPARE_BASES)[number];

// ─── sprigr/home_subject_facts ─────────────────────────────────────────────

export const HOME_SUBJECT_FACTS = [
  'overdue_invoice', 'open_invoice', 'open_quote', 'last_visit_note',
  'open_ticket', 'recent_order', 'unpaid_job', 'credit_hold',
] as const;
export type SubjectFact = (typeof HOME_SUBJECT_FACTS)[number];

/** `bulk`: every fact for the window. `ref`: the facts for one of THIS app's ids. */
export const HOME_SUBJECT_FACT_MODES = ['bulk', 'ref'] as const;
export type SubjectFactMode = (typeof HOME_SUBJECT_FACT_MODES)[number];

// ─── sprigr/home_identity ──────────────────────────────────────────────────

export const HOME_IDENTITY_CONNECTIONS = ['personal', 'install_login', 'not_connected', 'expired'] as const;
export type IdentityConnection = (typeof HOME_IDENTITY_CONNECTIONS)[number];

// ─── Caps and limits ───────────────────────────────────────────────────────

/**
 * Record caps per answer (3.2). `subject_facts` depends on the request mode.
 * Identity answers with exactly one status record.
 */
export const HOME_RECORD_CAPS = {
  'sprigr/home_schedule': 200,
  'sprigr/home_queue': 50,
  'sprigr/home_metrics': 12,
  'sprigr/home_subject_facts': { bulk: 500, ref: 20 },
  'sprigr/home_identity': 1,
} as const;

/** The platform's dispatch cut and the deadline it hands the app (section 6). */
export const HOME_DISPATCH_TIMEOUT_MS = 4000;
export const HOME_APP_DEADLINE_MS = 3500;

/** Manifest limits (4.3). */
export const HOME_MAX_PROVIDERS = 8;
export const HOME_MAX_LINK_HOSTS = 4;
/** Not stated by the spec: chosen here as the same bound as providers. */
export const HOME_MAX_LINKS = 8;
export const HOME_TTL_MIN_SECONDS = 60;
export const HOME_TTL_MAX_SECONDS = 3600;
export const HOME_RATE_MIN_PER_MINUTE = 1;
export const HOME_RATE_MAX_PER_MINUTE = 60;

/** `provides[].id`, the identity provider id, link ids and the rate group (4.3 rule 4). */
export const HOME_PROVIDER_ID_REGEX = /^[a-z][a-z0-9_]{1,31}$/;

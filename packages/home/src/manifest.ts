/**
 * Home Contracts: the manifest `home` block and its publish-time validator,
 * `validateHome` (FINAL-APP-FEEDS 4.3).
 *
 * Closed: every rule refuses, nothing is cut, and an unknown key at any level
 * is refused. The block names which platform-owned contracts the app answers
 * and points at ONE read-only routed tool; contracts come only from the
 * `sprigr/` namespace, and no other part of a manifest may name a
 * `sprigr/home_*` contract (only the platform consumes them).
 *
 * Runs in three places with the same verdicts: the publish (validateManifest
 * in workers/provisioning), `sprigr app validate` (apps/cli, a copy of this
 * file kept identical by a drift test), and on read (`homeBlockFromManifest`),
 * because a version published before this validator existed could carry any
 * `home` value. Fixture files need the upload, so they are checked separately
 * (fixtures.ts).
 *
 * Self-contained, so it lifts into `@sprigr/apps-home` unchanged (see
 * vocabulary.ts). The one platform rule it cannot carry, the dispatch tier
 * classifier, is passed in.
 */

import {
  HOME_AUDIENCES,
  HOME_CONTRACT_IDS,
  HOME_CONTRACT_SERVED_VERSIONS,
  HOME_CREW_ROLES,
  HOME_IDENTITY_CONTRACT_ID,
  HOME_IDENTITY_METHODS,
  HOME_MAX_LINK_HOSTS,
  HOME_MAX_LINKS,
  HOME_MAX_PROVIDERS,
  HOME_METRIC_IDS,
  HOME_PROVIDER_CONTRACT_IDS,
  HOME_PROVIDER_ID_REGEX,
  HOME_QUEUE_REASONS,
  HOME_QUEUE_WHYS,
  HOME_RATE_MAX_PER_MINUTE,
  HOME_RATE_MIN_PER_MINUTE,
  HOME_ROLES,
  HOME_SCOPES,
  HOME_SUBJECT_FACTS,
  HOME_SUBJECT_FACT_MODES,
  HOME_TTL_MAX_SECONDS,
  HOME_TTL_MIN_SECONDS,
  HOME_VERSION_REQUIREMENT_REGEX,
  homeBaselineVersion,
  isHomeContractId,
  isHomeNamespaceId,
  type HomeContractId,
} from './vocabulary';
import type { HomeBlock, HomeProviderDeclaration } from './types';

/** The manifest fields this module reads. Structural, so callers need not hold a full AppManifest. */
export interface HomeManifestLike {
  metadata?: { slug?: unknown } | null;
  tools?: ReadonlyArray<
    | {
        name?: unknown;
        handler?: unknown;
        internal?: unknown;
        effects?: unknown;
        dispatch?: { writeActions?: unknown } | null;
      }
    | null
    | undefined
  > | null;
  cross_tenant_tools?: ReadonlyArray<{ tool_name?: unknown; provides?: unknown } | null | undefined> | null;
  app_dependencies?: ReadonlyArray<{ app?: unknown } | null | undefined> | null;
  home?: unknown;
}

/** Platform rules this module cannot carry itself, passed in by the caller. */
export interface HomeValidationDeps {
  /** The dispatch tier classifier (`isReadShapedDispatch` in @sprigr/team-shared). */
  isReadShapedDispatch(name: string, declaredEffects?: 'write' | null): boolean;
}

/** The one name a Home tool may have: `get_<slug with dashes as underscores>_home`. It matches the
 *  classifier's `get_` read prefix directly, whatever the slug (4.3 rule 3). */
export function homeToolNameFor(slug: string): string {
  return `get_${slug.replace(/-/g, '_')}_home`;
}

const F = 'home';
const BLOCK_KEYS = ['tool', 'links', 'link_hosts', 'identity', 'rate', 'provides'] as const;
const PROVIDER_KEYS = ['id', 'contract', 'version', 'scope', 'audience', 'roles', 'requires_person', 'ttl_seconds', 'fixtures'] as const;
/** Vocabulary keys, each allowed on exactly one contract (4.3 rule 6). */
const VOCAB_KEYS: Readonly<Record<string, { contract: HomeContractId; values: readonly string[] }>> = {
  metrics: { contract: 'sprigr/home_metrics', values: HOME_METRIC_IDS },
  facts: { contract: 'sprigr/home_subject_facts', values: HOME_SUBJECT_FACTS },
  modes: { contract: 'sprigr/home_subject_facts', values: HOME_SUBJECT_FACT_MODES },
  reasons: { contract: 'sprigr/home_queue', values: HOME_QUEUE_REASONS },
  whys: { contract: 'sprigr/home_queue', values: HOME_QUEUE_WHYS },
};
const IDENTITY_KEYS = ['contract', 'version', 'provider', 'methods'] as const;
const RATE_KEYS = ['group', 'max_dispatches_per_minute'] as const;
const LINK_KEYS = ['id', 'page', 'url', 'opens_in'] as const;

/** An exact DNS hostname: no wildcard, no IP literal (the last label is letters), no port. */
const HOSTNAME_RX = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** `opens_in`: a plain name as a user says it (the decision 0153 and 0156 text rules): letters,
 *  digits, spaces and & ' ( ) -. So no URL, domain, markup, underscore or emoji. */
const PLAIN_LABEL_RX = /^[\p{L}\p{N}][\p{L}\p{N} &'()-]*$/u;
const PLAIN_LABEL_MAX = 40;
const FIXTURE_PATH_RX = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._\-/]+\.json$/;
const FIXTURE_PATH_MAX = 200;
const LINK_TEMPLATE_MAX = 300;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A manifest list, or none. A malformed one (not an array) is the owning validator's refusal, not a throw here. */
function entries<T>(v: ReadonlyArray<T> | null | undefined): ReadonlyArray<T> {
  return Array.isArray(v) ? v : [];
}

function got(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  return typeof v === 'string' ? `"${v}"` : `${typeof v} ${String(v)}`;
}

function unknownKey(v: Record<string, unknown>, allowed: readonly string[], path: string): string | null {
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) return `${path} has unknown key "${key}"; allowed: ${allowed.join(', ')}`;
  }
  return null;
}

/** A non-empty array of unique strings from `values`, or the refusal. */
function closedList(v: unknown, values: readonly string[], path: string): string | null {
  if (!Array.isArray(v) || v.length === 0) return `${path} must be a non-empty array of: ${values.join(', ')}`;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string' || !values.includes(item)) {
      return `${path} has ${got(item)}, which is not one of: ${values.join(', ')}`;
    }
    if (seen.has(item)) return `${path} lists "${item}" twice`;
    seen.add(item);
  }
  return null;
}

function contractProblem(v: unknown, path: string): string | null {
  if (typeof v !== 'string' || !isHomeNamespaceId(v)) {
    return `${path} must name a platform contract from the sprigr/ namespace (${HOME_CONTRACT_IDS.join(', ')}), got ${got(v)}`;
  }
  if (!isHomeContractId(v)) return `${path} "${v}" is not a contract the platform serves; one of: ${HOME_CONTRACT_IDS.join(', ')}`;
  return null;
}

function versionProblem(contract: HomeContractId, v: unknown, path: string): string | null {
  if (typeof v !== 'string' || !HOME_VERSION_REQUIREMENT_REGEX.test(v)) {
    return `${path} must be a version requirement like "^1.0", got ${got(v)}`;
  }
  if (!homeBaselineVersion(contract, v)) {
    return `${path} "${v}" asks for a version of ${contract} the platform does not serve (served: ${HOME_CONTRACT_SERVED_VERSIONS[contract].join(', ')})`;
  }
  return null;
}

function plainLabelProblem(v: unknown, path: string): string | null {
  if (typeof v !== 'string' || v.trim() === '') return `${path} is required: the name the Open control shows, e.g. "Xero"`;
  if (v.length > PLAIN_LABEL_MAX) return `${path} is ${v.length} characters; max ${PLAIN_LABEL_MAX}`;
  if (!PLAIN_LABEL_RX.test(v)) {
    return `${path} must be a plain name (letters, digits, spaces and & ' ( ) -): no URL, domain, markup, underscore or emoji`;
  }
  return null;
}

// ─── The tool ──────────────────────────────────────────────────────────────

function toolProblem(raw: Record<string, unknown>, manifest: HomeManifestLike, deps: HomeValidationDeps): string | null {
  const slug = typeof manifest.metadata?.slug === 'string' ? manifest.metadata.slug : '';
  const expected = homeToolNameFor(slug);
  const tool = raw.tool;
  if (Array.isArray(tool)) {
    return `${F}.tool must be ONE tool name, got an array: an app has one read-only Home tool, which routes on the provider id`;
  }
  if (typeof tool !== 'string' || tool === '') return `${F}.tool is required: the name of this app's one Home tool, "${expected}"`;
  if (tool !== expected) {
    return `${F}.tool must be named "${expected}" (get_<app slug with dashes as underscores>_home), got "${tool}": the name keeps it on the read dispatch tier`;
  }
  const decl = entries(manifest.tools).find((t) => t?.name === tool);
  if (!decl) return `${F}.tool "${tool}" is not declared in tools[]`;
  if (typeof decl.handler !== 'string' || decl.handler === '') return `tools[] "${tool}" needs a handler: the platform dispatches the Home tool to the bundle`;
  if (decl.internal !== true) return `tools[] "${tool}" must be internal: true: only the platform calls the Home tool, never an agent`;
  if (decl.effects === 'write') return `tools[] "${tool}" declares effects: 'write'; the Home tool must be read-only`;
  const writeActions = decl.dispatch?.writeActions;
  if (Array.isArray(writeActions) && writeActions.length > 0) {
    return `tools[] "${tool}" lists dispatch.writeActions; the Home tool must be read-only`;
  }
  if (!deps.isReadShapedDispatch(tool, null)) {
    return `${F}.tool "${tool}" does not classify as a read for dispatch; the Home tool must be read-only`;
  }
  for (const t of entries(manifest.cross_tenant_tools)) {
    if (t?.tool_name === tool) return `cross_tenant_tools must not expose "${tool}": the Home tool is platform-only`;
  }
  return null;
}

// ─── Links ─────────────────────────────────────────────────────────────────

function linkHostsProblem(v: unknown): string | null {
  if (v === undefined) return null;
  const path = `${F}.link_hosts`;
  if (!Array.isArray(v)) return `${path} must be an array of exact hostnames, got ${got(v)}`;
  if (v.length > HOME_MAX_LINK_HOSTS) return `${path} has ${v.length} hosts; max ${HOME_MAX_LINK_HOSTS}`;
  const seen = new Set<string>();
  for (const h of v) {
    if (typeof h !== 'string' || !HOSTNAME_RX.test(h)) {
      return `${path} entry ${got(h)} must be an exact lowercase hostname like "go.xero.com": no wildcard, IP address, port or scheme`;
    }
    if (seen.has(h)) return `${path} lists "${h}" twice`;
    seen.add(h);
  }
  return null;
}

function countRef(template: string): number {
  return template.split('{ref}').length - 1;
}

function linkProblem(link: unknown, path: string, hosts: readonly string[]): string | null {
  if (!isObject(link)) return `${path} must be an object like { "id": "job", "page": "/jobs/{ref}", "opens_in": "Simpro" }, got ${got(link)}`;
  const uk = unknownKey(link, LINK_KEYS, path);
  if (uk) return uk;
  if (typeof link.id !== 'string' || !HOME_PROVIDER_ID_REGEX.test(link.id)) {
    return `${path}.id must match ^[a-z][a-z0-9_]{1,31}$, got ${got(link.id)}`;
  }
  const hasPage = link.page !== undefined;
  const hasUrl = link.url !== undefined;
  if (hasPage === hasUrl) return `${path} must have exactly one of page (an app page) or url (an https URL on home.link_hosts)`;
  const template = hasPage ? link.page : link.url;
  const which = hasPage ? 'page' : 'url';
  if (typeof template !== 'string' || template.length > LINK_TEMPLATE_MAX || /\s/.test(template)) {
    return `${path}.${which} must be a string of at most ${LINK_TEMPLATE_MAX} characters with no spaces`;
  }
  if (countRef(template) !== 1) return `${path}.${which} must contain {ref} exactly once; the platform fills it with the record's URL-encoded id`;
  if (hasPage) {
    if (!template.startsWith('/') || template.startsWith('//') || template.includes('://')) {
      return `${path}.page must be a path in this app starting with "/", like "/jobs/{ref}"`;
    }
  } else {
    const m = /^https:\/\/([^/?#]+)([/?#].*)?$/.exec(template);
    if (!m) return `${path}.url must be an https URL, like "https://go.xero.com/app/invoicing/view/{ref}"`;
    const authority = m[1] ?? '';
    if (authority.includes('{ref}')) return `${path}.url must not put {ref} in the host`;
    if (authority.includes('@') || authority.includes(':')) return `${path}.url must not carry credentials or a port`;
    if (!hosts.includes(authority)) {
      return `${path}.url host "${authority}" is not in home.link_hosts; declare the exact hostname there (it is separate from permissions.network_domains)`;
    }
  }
  return plainLabelProblem(link.opens_in, `${path}.opens_in`);
}

function linksProblem(v: unknown, hosts: readonly string[]): string | null {
  if (v === undefined) return null;
  const path = `${F}.links`;
  if (!Array.isArray(v)) return `${path} must be an array, got ${got(v)}`;
  if (v.length > HOME_MAX_LINKS) return `${path} has ${v.length} links; max ${HOME_MAX_LINKS}`;
  const ids = new Set<string>();
  for (let i = 0; i < v.length; i += 1) {
    const err = linkProblem(v[i], `${path}[${i}]`, hosts);
    if (err) return err;
    const id = (v[i] as { id: string }).id;
    if (ids.has(id)) return `${path} declares id "${id}" twice`;
    ids.add(id);
  }
  return null;
}

// ─── Identity and rate ─────────────────────────────────────────────────────

function identityProblem(v: unknown): string | null {
  if (v === undefined) return null;
  const path = `${F}.identity`;
  if (!isObject(v)) return `${path} must be an object like { "contract": "sprigr/home_identity", "version": "^1.0", "provider": "whoami", "methods": ["native"] }`;
  const uk = unknownKey(v, IDENTITY_KEYS, path);
  if (uk) return uk;
  const cErr = contractProblem(v.contract, `${path}.contract`);
  if (cErr) return cErr;
  if (v.contract !== HOME_IDENTITY_CONTRACT_ID) return `${path}.contract must be ${HOME_IDENTITY_CONTRACT_ID}, got "${String(v.contract)}"`;
  const vErr = versionProblem(HOME_IDENTITY_CONTRACT_ID, v.version, `${path}.version`);
  if (vErr) return vErr;
  if (typeof v.provider !== 'string' || !HOME_PROVIDER_ID_REGEX.test(v.provider)) {
    return `${path}.provider must match ^[a-z][a-z0-9_]{1,31}$, got ${got(v.provider)}`;
  }
  return closedList(v.methods, HOME_IDENTITY_METHODS, `${path}.methods`);
}

function rateProblem(v: unknown): string | null {
  const path = `${F}.rate`;
  if (v === undefined) {
    return `${path} is required: { "group": "<label>", "max_dispatches_per_minute": ${HOME_RATE_MIN_PER_MINUTE} to ${HOME_RATE_MAX_PER_MINUTE} }, the cap the platform holds this app's Home dispatches to`;
  }
  if (!isObject(v)) return `${path} must be an object, got ${got(v)}`;
  const uk = unknownKey(v, RATE_KEYS, path);
  if (uk) return uk;
  if (typeof v.group !== 'string' || !HOME_PROVIDER_ID_REGEX.test(v.group)) {
    return `${path}.group must match ^[a-z][a-z0-9_]{1,31}$, got ${got(v.group)}`;
  }
  const n = v.max_dispatches_per_minute;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < HOME_RATE_MIN_PER_MINUTE || n > HOME_RATE_MAX_PER_MINUTE) {
    return `${path}.max_dispatches_per_minute must be an integer from ${HOME_RATE_MIN_PER_MINUTE} to ${HOME_RATE_MAX_PER_MINUTE}, got ${got(n)}`;
  }
  return null;
}

// ─── Providers ─────────────────────────────────────────────────────────────

function providerProblem(p: unknown, path: string): string | null {
  if (!isObject(p)) return `${path} must be an object, got ${got(p)}`;
  const cErr = contractProblem(p.contract, `${path}.contract`);
  if (cErr) return cErr;
  const contract = p.contract as HomeContractId;
  if (contract === HOME_IDENTITY_CONTRACT_ID) {
    return `${path}.contract ${HOME_IDENTITY_CONTRACT_ID} is declared once in home.identity, not as a provider`;
  }
  if (!(HOME_PROVIDER_CONTRACT_IDS as readonly string[]).includes(contract)) {
    return `${path}.contract "${contract}" cannot be a provider; one of: ${HOME_PROVIDER_CONTRACT_IDS.join(', ')}`;
  }
  for (const key of Object.keys(p)) {
    if ((PROVIDER_KEYS as readonly string[]).includes(key)) continue;
    const vocab = VOCAB_KEYS[key];
    if (vocab && vocab.contract !== contract) return `${path}.${key} is only for ${vocab.contract}, not ${contract}`;
    if (!vocab) {
      const allowed = [...PROVIDER_KEYS, ...Object.keys(VOCAB_KEYS).filter((k) => VOCAB_KEYS[k]?.contract === contract)];
      return `${path} has unknown key "${key}"; allowed for ${contract}: ${allowed.join(', ')}`;
    }
  }
  if (typeof p.id !== 'string' || !HOME_PROVIDER_ID_REGEX.test(p.id)) {
    return `${path}.id must match ^[a-z][a-z0-9_]{1,31}$, got ${got(p.id)}`;
  }
  const vErr = versionProblem(contract, p.version, `${path}.version`);
  if (vErr) return vErr;
  if (typeof p.scope !== 'string' || !(HOME_SCOPES as readonly string[]).includes(p.scope)) {
    return `${path}.scope must be one of ${HOME_SCOPES.join(', ')}, got ${got(p.scope)}`;
  }
  if (typeof p.audience !== 'string' || !(HOME_AUDIENCES as readonly string[]).includes(p.audience)) {
    return `${path}.audience must be one of ${HOME_AUDIENCES.join(', ')}, got ${got(p.audience)}`;
  }
  const rErr = closedList(p.roles, HOME_ROLES, `${path}.roles`);
  if (rErr) return rErr;
  if (p.scope === 'crew') {
    const wide = (p.roles as string[]).find((r) => !(HOME_CREW_ROLES as readonly string[]).includes(r));
    if (wide) return `${path}.roles may not include "${wide}" on a crew provider; crew is for ${HOME_CREW_ROLES.join(', ')} only`;
  }
  // The audience sets the actor (7.1): a company dispatch stamps no person, so it cannot answer "me" or need a person link.
  if (p.scope === 'me' && p.audience !== 'per_user') {
    return `${path}.scope me needs audience per_user: a company-audience dispatch carries no person, so there is no "me"`;
  }
  if (p.requires_person !== undefined && typeof p.requires_person !== 'boolean') {
    return `${path}.requires_person must be true or false, got ${got(p.requires_person)}`;
  }
  if (p.requires_person === true && p.audience !== 'per_user') {
    return `${path}.requires_person needs audience per_user: a company-audience dispatch carries no person to link`;
  }
  const ttl = p.ttl_seconds;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < HOME_TTL_MIN_SECONDS || ttl > HOME_TTL_MAX_SECONDS) {
    return `${path}.ttl_seconds must be an integer from ${HOME_TTL_MIN_SECONDS} to ${HOME_TTL_MAX_SECONDS}, got ${got(ttl)}`;
  }
  const fx = p.fixtures;
  if (typeof fx !== 'string' || fx.length > FIXTURE_PATH_MAX || !FIXTURE_PATH_RX.test(fx)) {
    return `${path}.fixtures must be a relative path to a .json file in the upload (no "..", no leading "/"), got ${got(fx)}`;
  }
  for (const [key, vocab] of Object.entries(VOCAB_KEYS)) {
    if (vocab.contract !== contract) continue;
    const err = closedList(p[key], vocab.values, `${path}.${key}`);
    if (err) return p[key] === undefined ? `${path}.${key} is required for ${contract}: the ${key} this provider answers with` : err;
  }
  return null;
}

// ─── Entry points ──────────────────────────────────────────────────────────

/**
 * The namespace rule, checked on EVERY manifest whether or not it has a `home`
 * block: only the platform consumes `sprigr/home_*` contracts, so no
 * cross-tenant tool may claim to provide one and no app may depend on one.
 */
export function homeNamespaceProblem(manifest: HomeManifestLike): string | null {
  for (const t of entries(manifest.cross_tenant_tools)) {
    const iface = isObject(t?.provides) ? t.provides.interface : undefined;
    if (isHomeNamespaceId(iface)) {
      return `cross_tenant_tools "${String(t?.tool_name)}" provides ${String(iface)}: Home contracts are answered through the manifest home block, never as a cross-tenant tool`;
    }
  }
  for (const d of entries(manifest.app_dependencies)) {
    const target = isObject(d?.app) ? d.app.provides : undefined;
    if (isHomeNamespaceId(target)) {
      return `app_dependencies names ${String(target)}: only the platform consumes Home contracts; an app cannot bind to one`;
    }
  }
  return null;
}

/**
 * Validate a manifest's `home` block (FINAL-APP-FEEDS 4.3) and the
 * `sprigr/home_*` namespace rule. Returns the first refusal, or null. A
 * manifest without a `home` block (absent or null) passes when the namespace
 * rule does.
 */
export function validateHome(manifest: HomeManifestLike, deps: HomeValidationDeps): string | null {
  const nsErr = homeNamespaceProblem(manifest);
  if (nsErr) return nsErr;
  const raw = manifest.home;
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    return `${F} must be an object like { "tool": "get_<slug>_home", "rate": { ... }, "provides": [ ... ] }, got ${got(raw)}`;
  }
  const uk = unknownKey(raw, BLOCK_KEYS, F);
  if (uk) return uk;
  const toolErr = toolProblem(raw, manifest, deps);
  if (toolErr) return toolErr;
  const hostsErr = linkHostsProblem(raw.link_hosts);
  if (hostsErr) return hostsErr;
  const hosts = Array.isArray(raw.link_hosts) ? (raw.link_hosts as string[]) : [];
  const linksErr = linksProblem(raw.links, hosts);
  if (linksErr) return linksErr;
  const identityErr = identityProblem(raw.identity);
  if (identityErr) return identityErr;
  const rateErr = rateProblem(raw.rate);
  if (rateErr) return rateErr;

  const provides = raw.provides;
  if (!Array.isArray(provides) || provides.length === 0) {
    return `${F}.provides must be a non-empty array: each entry is one provider of a sprigr/home_* contract`;
  }
  if (provides.length > HOME_MAX_PROVIDERS) return `${F}.provides has ${provides.length} providers; max ${HOME_MAX_PROVIDERS}`;
  const ids = new Set<string>();
  const identityId = isObject(raw.identity) ? raw.identity.provider : undefined;
  for (let i = 0; i < provides.length; i += 1) {
    const path = `${F}.provides[${i}]`;
    const err = providerProblem(provides[i], path);
    if (err) return err;
    const id = (provides[i] as { id: string }).id;
    if (ids.has(id)) return `${path}.id "${id}" is declared twice`;
    if (id === identityId) return `${path}.id "${id}" is also the identity provider id; provider ids must be distinct`;
    ids.add(id);
  }
  if (raw.identity === undefined && provides.some((p) => (p as { requires_person?: unknown }).requires_person === true)) {
    return `${F}.identity is required when a provider sets requires_person: the platform needs it to find the viewer's vendor person`;
  }
  return null;
}

/**
 * The validated block for an installed version, or undefined. A value that
 * fails `validateHome` (a version published before the rules existed) is
 * dropped with an operator warning, never dispatched.
 */
export function homeBlockFromManifest(
  manifest: unknown,
  deps: HomeValidationDeps,
  warn: (message: string) => void = () => {},
): HomeBlock | undefined {
  if (!isObject(manifest)) return undefined;
  const m = manifest as HomeManifestLike;
  if (m.home === undefined || m.home === null) return undefined;
  const err = validateHome(m, deps);
  if (err) {
    warn(`ignoring the home block: ${err}`);
    return undefined;
  }
  return m.home as HomeBlock;
}

/** The fixture file each provider names, in declaration order. */
export function homeFixturePaths(block: HomeBlock): Array<{ provider: HomeProviderDeclaration; path: string }> {
  return block.provides.map((provider) => ({ provider, path: provider.fixtures }));
}

/**
 * One row of the Home provider catalogue (NEW `home_providers`, written after
 * the version row commits; a later slice owns the table and the write). Pure,
 * so the row shape is fixed here and tested before the table exists.
 */
export interface HomeProviderCatalogueRow {
  version_id: string;
  app_slug: string;
  contract: HomeContractId;
  /** The requirement as declared, e.g. "^1.0". */
  contract_version: string;
  provider_id: string;
  scope: HomeProviderDeclaration['scope'];
  audience: HomeProviderDeclaration['audience'];
  /** JSON array text, e.g. '["owner","admin"]'. */
  roles: string;
  trust_tier: string;
}

export function homeProviderCatalogueRows(
  block: HomeBlock,
  args: { versionId: string; appSlug: string; trustTier: string },
): HomeProviderCatalogueRow[] {
  return block.provides.map((p) => ({
    version_id: args.versionId,
    app_slug: args.appSlug,
    contract: p.contract,
    contract_version: p.version,
    provider_id: p.id,
    scope: p.scope,
    audience: p.audience,
    roles: JSON.stringify(p.roles),
    trust_tier: args.trustTier,
  }));
}

/** The `CACHE_KV` key the validated block is materialised under (no TTL), a later slice's write. */
export function homeDeclarationKey(versionId: string): string {
  return `mkt-home-decl:${versionId}`;
}

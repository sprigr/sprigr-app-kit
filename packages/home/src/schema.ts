/**
 * Home Contracts: one small field-spec language that drives three things, so
 * they cannot drift (FINAL-APP-FEEDS 3.2, "The JSON schemas are generated from
 * the same source as the validator"):
 *   - `checkHomeValue`: the runtime validator (closed objects, closed enums,
 *     caps, UTC instants, local days);
 *   - `homeJsonSchema`: the JSON Schema published in the `sprigr/` contract
 *     definitions (definitions.ts);
 *   - `flattenHomeFields`: the decision 0030 field list, with the sensitivity
 *     tags the platform assigns (the app cannot change a tag).
 *
 * Hand-written, no JSON Schema library (decision 0027), and self-contained so
 * it lifts into `@sprigr/apps-home` unchanged.
 */

import { HOME_PROVIDER_ID_REGEX, HOME_SEMVER_REGEX, type HomeSensitivityTag } from './vocabulary';

/** String formats the platform checks beyond type and length. */
export type HomeStringFormat =
  | 'instant'
  | 'local_day'
  | 'time_zone'
  | 'currency'
  | 'semver'
  | 'app_slug'
  | 'email'
  | 'provider_id';

export type HomeFieldSpec =
  | {
      readonly type: 'string';
      readonly min?: number;
      readonly max?: number;
      readonly enum?: readonly string[];
      readonly format?: HomeStringFormat;
      /** A display string: the Home sanitizer applies to it and fixtures must already be clean. */
      readonly display?: boolean;
    }
  | { readonly type: 'integer'; readonly min?: number; readonly max?: number }
  | { readonly type: 'number' }
  | { readonly type: 'boolean' }
  /** A string or a finite number (DetailField.value). */
  | { readonly type: 'scalar'; readonly max?: number; readonly display?: boolean }
  | { readonly type: 'object'; readonly fields: HomeObjectFields }
  | { readonly type: 'array'; readonly items: HomeFieldSpec; readonly min?: number; readonly max?: number }
  /** A discriminated union on `tag` (MetricValue, MetricPeriod, HomeRequest.mode). */
  | { readonly type: 'tagged'; readonly tag: string; readonly variants: Readonly<Record<string, HomeObjectFields>> }
  /** Any JSON value, unchecked: a fixture's opaque `vendor` data, or records checked one by one elsewhere. */
  | { readonly type: 'any' };

export interface HomeFieldEntry {
  readonly spec: HomeFieldSpec;
  readonly required: boolean;
  /** Decision 0030 tags the platform assigns to this field. */
  readonly sensitivity?: readonly HomeSensitivityTag[];
}

export type HomeObjectFields = Readonly<Record<string, HomeFieldEntry>>;

// ─── Builders (keep the record specs short) ────────────────────────────────

export function req(spec: HomeFieldSpec, sensitivity?: readonly HomeSensitivityTag[]): HomeFieldEntry {
  return sensitivity ? { spec, required: true, sensitivity } : { spec, required: true };
}

export function opt(spec: HomeFieldSpec, sensitivity?: readonly HomeSensitivityTag[]): HomeFieldEntry {
  return sensitivity ? { spec, required: false, sensitivity } : { spec, required: false };
}

/** A non-empty string of at most `max` characters. */
export function str(max: number, extra?: { display?: boolean; format?: HomeStringFormat }): HomeFieldSpec {
  return { type: 'string', min: 1, max, ...(extra ?? {}) };
}

export function oneOf(values: readonly string[]): HomeFieldSpec {
  return { type: 'string', enum: values };
}

export function fmt(format: HomeStringFormat): HomeFieldSpec {
  return { type: 'string', format };
}

export function obj(fields: HomeObjectFields): HomeFieldSpec {
  return { type: 'object', fields };
}

export function list(items: HomeFieldSpec, bounds: { min?: number; max: number }): HomeFieldSpec {
  return { type: 'array', items, ...bounds };
}

// ─── Formats ───────────────────────────────────────────────────────────────

/** ISO 8601 UTC with a Z suffix, as the fulfilment hub contract words it. */
const INSTANT_RX = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/;
const LOCAL_DAY_RX = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RX = /^[A-Z]{3}$/;
const APP_SLUG_RX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+$/;

const FORMAT_PATTERNS: Readonly<Partial<Record<HomeStringFormat, RegExp>>> = {
  instant: INSTANT_RX,
  local_day: LOCAL_DAY_RX,
  currency: CURRENCY_RX,
  semver: HOME_SEMVER_REGEX,
  app_slug: APP_SLUG_RX,
  email: EMAIL_RX,
  provider_id: HOME_PROVIDER_ID_REGEX,
};

const FORMAT_WORDS: Readonly<Record<HomeStringFormat, string>> = {
  instant: 'a UTC instant like 2026-10-06T21:30:00Z',
  local_day: 'a calendar date like 2026-10-07',
  time_zone: 'an IANA time zone like Australia/Brisbane',
  currency: 'an ISO 4217 code like AUD',
  semver: 'a MAJOR.MINOR.PATCH version',
  app_slug: 'an app slug',
  email: 'an email address',
  provider_id: 'an id matching ^[a-z][a-z0-9_]{1,31}$',
};

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/** Zones already accepted. Only valid zones are kept, so the set is bounded by the IANA list. */
const knownZones = new Set<string>();

/** True for a time zone the runtime's Intl knows (Workers and Node both ship full ICU). */
export function isHomeTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return false;
  if (knownZones.has(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return false;
  }
  knownZones.add(tz);
  return true;
}

/** A plausible email address: something, one @, something, no spaces. Matching is exact and platform-side (7.2). */
export function isHomeEmail(v: unknown): v is string {
  return typeof v === 'string' && EMAIL_RX.test(v);
}

/** The ABN checksum weights: subtract 1 from the first digit, weight each digit, and the sum divides by 89. */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

/**
 * An Australian Business Number as FINAL-APP-FEEDS 8.4 checks it: exactly 11
 * digits that pass the ABN checksum. No spaces: the app sends the digits.
 */
export function isHomeAbn(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{11}$/.test(v)) return false;
  let sum = 0;
  ABN_WEIGHTS.forEach((weight, i) => {
    sum += (v.charCodeAt(i) - 48 - (i === 0 ? 1 : 0)) * weight;
  });
  return sum % 89 === 0;
}

export function isHomeInstant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = INSTANT_RX.exec(v);
  if (!m) return false;
  return isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) && !Number.isNaN(Date.parse(v));
}

export function isHomeLocalDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = LOCAL_DAY_RX.exec(v);
  return !!m && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function formatOk(format: HomeStringFormat, v: string): boolean {
  switch (format) {
    case 'instant':
      return isHomeInstant(v);
    case 'local_day':
      return isHomeLocalDay(v);
    case 'time_zone':
      return isHomeTimeZone(v);
    default: {
      const rx = FORMAT_PATTERNS[format];
      return !!rx && rx.test(v);
    }
  }
}

// ─── Validator ─────────────────────────────────────────────────────────────

export function isPlainHomeObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 40)}...` : v}"`;
  if (typeof v === 'object') return 'an object';
  return `${typeof v} ${String(v)}`;
}

function checkObject(value: unknown, fields: HomeObjectFields, path: string, out: string[], extraKeys?: ReadonlySet<string>): void {
  if (!isPlainHomeObject(value)) {
    out.push(`${path} must be an object, got ${describe(value)}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in fields) && !extraKeys?.has(key)) {
      out.push(`${path} has unknown key "${key}"; allowed: ${[...(extraKeys ?? []), ...Object.keys(fields)].join(', ')}`);
    }
  }
  for (const [key, entry] of Object.entries(fields)) {
    const v = value[key];
    if (v === undefined) {
      if (entry.required) out.push(`${path}.${key} is required`);
      continue;
    }
    checkHomeValue(v, entry.spec, `${path}.${key}`, out);
  }
}

/**
 * Append every problem with `value` against `spec` to `out`, each naming its
 * path. Closed: an unknown key is a problem, never ignored.
 */
export function checkHomeValue(value: unknown, spec: HomeFieldSpec, path: string, out: string[]): void {
  switch (spec.type) {
    case 'any':
      return;
    case 'string': {
      if (typeof value !== 'string') {
        out.push(`${path} must be a string, got ${describe(value)}`);
        return;
      }
      if (spec.enum && !spec.enum.includes(value)) {
        out.push(`${path} must be one of ${spec.enum.join(', ')}, got ${describe(value)}`);
        return;
      }
      if (spec.min !== undefined && value.length < spec.min) {
        out.push(spec.min === 1 ? `${path} must not be empty` : `${path} must be at least ${spec.min} characters`);
        return;
      }
      if (spec.max !== undefined && value.length > spec.max) {
        out.push(`${path} is ${value.length} characters; max ${spec.max}`);
        return;
      }
      if (spec.format && !formatOk(spec.format, value)) {
        out.push(`${path} must be ${FORMAT_WORDS[spec.format]}, got ${describe(value)}`);
      }
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        out.push(`${path} must be an integer, got ${describe(value)}`);
        return;
      }
      if (spec.min !== undefined && value < spec.min) out.push(`${path} must be at least ${spec.min}, got ${value}`);
      else if (spec.max !== undefined && value > spec.max) out.push(`${path} must be at most ${spec.max}, got ${value}`);
      return;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path} must be a finite number, got ${describe(value)}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path} must be true or false, got ${describe(value)}`);
      return;
    case 'scalar': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) out.push(`${path} must be a finite number or a string, got ${describe(value)}`);
        return;
      }
      if (typeof value !== 'string') {
        out.push(`${path} must be a string or a number, got ${describe(value)}`);
        return;
      }
      if (spec.max !== undefined && value.length > spec.max) out.push(`${path} is ${value.length} characters; max ${spec.max}`);
      return;
    }
    case 'object':
      checkObject(value, spec.fields, path, out);
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        out.push(`${path} must be an array, got ${describe(value)}`);
        return;
      }
      if (spec.min !== undefined && value.length < spec.min) {
        out.push(`${path} must have at least ${spec.min} ${spec.min === 1 ? 'entry' : 'entries'}`);
        return;
      }
      if (spec.max !== undefined && value.length > spec.max) {
        out.push(`${path} has ${value.length} entries; max ${spec.max}`);
        return;
      }
      value.forEach((item, i) => checkHomeValue(item, spec.items, `${path}[${i}]`, out));
      return;
    }
    case 'tagged': {
      if (!isPlainHomeObject(value)) {
        out.push(`${path} must be an object, got ${describe(value)}`);
        return;
      }
      const tag = value[spec.tag];
      const kinds = Object.keys(spec.variants);
      if (typeof tag !== 'string' || !kinds.includes(tag)) {
        out.push(`${path}.${spec.tag} must be one of ${kinds.join(', ')}, got ${describe(tag)}`);
        return;
      }
      const fields = spec.variants[tag];
      if (fields) checkObject(value, fields, path, out, new Set([spec.tag]));
      return;
    }
  }
}

/** All problems with `value` against `spec`, rooted at `path`. */
export function homeValueProblems(value: unknown, spec: HomeFieldSpec, path: string): string[] {
  const out: string[] = [];
  checkHomeValue(value, spec, path, out);
  return out;
}

// ─── Display strings ───────────────────────────────────────────────────────

/**
 * Call `fn` for every display string in an already-valid `value` (a field
 * whose spec says `display: true`). The Home sanitizer and the fixture check
 * walk the same set.
 */
export function forEachHomeDisplayString(
  value: unknown,
  spec: HomeFieldSpec,
  path: string,
  fn: (text: string, path: string) => void,
): void {
  switch (spec.type) {
    case 'string':
    case 'scalar':
      if (spec.display && typeof value === 'string') fn(value, path);
      return;
    case 'object':
      if (!isPlainHomeObject(value)) return;
      for (const [key, entry] of Object.entries(spec.fields)) {
        if (value[key] !== undefined) forEachHomeDisplayString(value[key], entry.spec, `${path}.${key}`, fn);
      }
      return;
    case 'array':
      if (Array.isArray(value)) value.forEach((item, i) => forEachHomeDisplayString(item, spec.items, `${path}[${i}]`, fn));
      return;
    case 'tagged': {
      if (!isPlainHomeObject(value)) return;
      const tag = value[spec.tag];
      const fields = typeof tag === 'string' ? spec.variants[tag] : undefined;
      if (fields) forEachHomeDisplayString(value, { type: 'object', fields }, path, fn);
      return;
    }
    default:
      return;
  }
}

// ─── JSON Schema ───────────────────────────────────────────────────────────

function objectSchema(fields: HomeObjectFields, tag?: { name: string; value: string }): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (tag) {
    properties[tag.name] = { const: tag.value };
    required.push(tag.name);
  }
  for (const [key, entry] of Object.entries(fields)) {
    properties[key] = homeJsonSchema(entry.spec);
    if (entry.required) required.push(key);
  }
  const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * The JSON Schema for `spec`. Structural rules only: the cross-field rules
 * (an `end` for a block, a `severity` only on `broken`, the basis echo) live
 * in records.ts and are stated in each contract's definition description.
 */
export function homeJsonSchema(spec: HomeFieldSpec): Record<string, unknown> {
  switch (spec.type) {
    case 'string': {
      const out: Record<string, unknown> = { type: 'string' };
      if (spec.enum) out.enum = [...spec.enum];
      if (spec.min !== undefined) out.minLength = spec.min;
      if (spec.max !== undefined) out.maxLength = spec.max;
      if (spec.format) {
        const rx = FORMAT_PATTERNS[spec.format];
        if (rx) out.pattern = rx.source;
      }
      return out;
    }
    case 'integer': {
      const out: Record<string, unknown> = { type: 'integer' };
      if (spec.min !== undefined) out.minimum = spec.min;
      if (spec.max !== undefined) out.maximum = spec.max;
      return out;
    }
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'scalar': {
      const out: Record<string, unknown> = { type: ['string', 'number'] };
      if (spec.max !== undefined) out.maxLength = spec.max;
      return out;
    }
    case 'object':
      return objectSchema(spec.fields);
    case 'array': {
      const out: Record<string, unknown> = { type: 'array', items: homeJsonSchema(spec.items) };
      if (spec.min !== undefined) out.minItems = spec.min;
      if (spec.max !== undefined) out.maxItems = spec.max;
      return out;
    }
    case 'tagged':
      return {
        oneOf: Object.entries(spec.variants).map(([value, fields]) => objectSchema(fields, { name: spec.tag, value })),
      };
    case 'any':
      return {};
  }
}

// ─── Decision 0030 field list ──────────────────────────────────────────────

export interface HomeFlatField {
  /** Dotted path; `[]` marks an array element: `subjects[].value`. */
  path: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  sensitivity: HomeSensitivityTag[];
}

/**
 * Every leaf of `fields` as a decision 0030 field (string, number, date,
 * boolean), carrying the tags of the nearest tagged ancestor. Union variants
 * are merged, first occurrence wins.
 */
export function flattenHomeFields(fields: HomeObjectFields): HomeFlatField[] {
  const out: HomeFlatField[] = [];
  const seen = new Set<string>();
  const push = (path: string, type: HomeFlatField['type'], tags: readonly HomeSensitivityTag[]) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, type, sensitivity: [...tags] });
  };
  const walk = (spec: HomeFieldSpec, path: string, tags: readonly HomeSensitivityTag[]): void => {
    switch (spec.type) {
      case 'string':
        push(path, spec.format === 'instant' || spec.format === 'local_day' ? 'date' : 'string', tags);
        return;
      case 'scalar':
        push(path, 'string', tags);
        return;
      case 'integer':
      case 'number':
        push(path, 'number', tags);
        return;
      case 'boolean':
        push(path, 'boolean', tags);
        return;
      case 'object':
        for (const [key, entry] of Object.entries(spec.fields)) walk(entry.spec, `${path}.${key}`, entry.sensitivity ?? tags);
        return;
      case 'array':
        walk(spec.items, `${path}[]`, tags);
        return;
      case 'tagged':
        push(`${path}.${spec.tag}`, 'string', tags);
        for (const fields of Object.values(spec.variants)) {
          for (const [key, entry] of Object.entries(fields)) walk(entry.spec, `${path}.${key}`, entry.sensitivity ?? tags);
        }
        return;
      case 'any':
        return;
    }
  };
  for (const [key, entry] of Object.entries(fields)) walk(entry.spec, key, entry.sensitivity ?? []);
  return out;
}

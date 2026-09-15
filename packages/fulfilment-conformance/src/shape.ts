/**
 * Hand-written structural checks for the fulfilment-hub v1 shapes.
 *
 * Deliberately NOT a JSON Schema library. The contract's shapes are small
 * and fixed, and the checks that matter here are the ones a schema keyword
 * cannot express anyway: integer minor units, ISO 8601 UTC timestamps, a
 * closed stage enum, an ack status enum. Hand-writing them keeps the
 * failure messages specific ("levels[0].on_hand must be an integer, got
 * 3.5") instead of a validator's path-and-keyword soup, and keeps the
 * package dependency-free so an adapter can run it inside a Worker test.
 */

/** One field's expected kind. Composites nest an ObjectSpec. */
export type FieldKind =
  | 'string'
  | 'nonempty_string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'iso_utc'
  | 'currency_code'
  | 'country_code'
  | 'string_array'
  | 'object'
  | { readonly enum: readonly string[] }
  | { readonly array_of: ObjectSpec }
  | { readonly object: ObjectSpec };

export interface ObjectSpec {
  readonly required?: Readonly<Record<string, FieldKind>>;
  readonly optional?: Readonly<Record<string, FieldKind>>;
}

/**
 * ISO 8601 in UTC, as the contract words it ("Timestamps are ISO 8601 UTC
 * strings"). A local-offset stamp (`+10:00`) is refused on purpose: the hub
 * stores these on decision-0030 `date` fields and two adapters disagreeing
 * about the zone is exactly the silent skew this contract exists to stop.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;

export function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function checkField(value: unknown, kind: FieldKind, path: string): string[] {
  if (typeof kind === 'object') {
    if ('enum' in kind) {
      if (typeof value !== 'string' || !kind.enum.includes(value)) {
        return [`${path} must be one of ${kind.enum.join(' | ')}, got ${describeValue(value)}`];
      }
      return [];
    }
    if ('array_of' in kind) {
      if (!Array.isArray(value)) return [`${path} must be an array, got ${describeValue(value)}`];
      return value.flatMap((entry, i) => checkShape(entry, kind.array_of, `${path}[${i}]`));
    }
    if (!isPlainObject(value)) return [`${path} must be an object, got ${describeValue(value)}`];
    return checkShape(value, kind.object, path);
  }

  switch (kind) {
    case 'string':
      return typeof value === 'string' ? [] : [`${path} must be a string, got ${describeValue(value)}`];
    case 'nonempty_string':
      return typeof value === 'string' && value.length > 0
        ? []
        : [`${path} must be a non-empty string, got ${describeValue(value)}`];
    case 'integer':
      return Number.isInteger(value)
        ? []
        : [`${path} must be an integer (the contract carries money in minor units and quantities as whole numbers), got ${describeValue(value)}`];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [`${path} must be a finite number, got ${describeValue(value)}`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} must be a boolean, got ${describeValue(value)}`];
    case 'iso_utc':
      return isIsoUtc(value)
        ? []
        : [`${path} must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ), got ${describeValue(value)}`];
    case 'currency_code':
      return typeof value === 'string' && CURRENCY.test(value)
        ? []
        : [`${path} must be an ISO 4217 alphabetic code, got ${describeValue(value)}`];
    case 'country_code':
      return typeof value === 'string' && COUNTRY.test(value)
        ? []
        : [`${path} must be an ISO 3166-1 alpha-2 code, got ${describeValue(value)}`];
    case 'string_array':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? []
        : [`${path} must be an array of strings, got ${describeValue(value)}`];
    case 'object':
      return isPlainObject(value) ? [] : [`${path} must be an object, got ${describeValue(value)}`];
    default:
      return [`${path} has an unknown field kind`];
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns one issue string per violation; an empty array means conforming. */
export function checkShape(value: unknown, spec: ObjectSpec, path = 'result'): string[] {
  if (!isPlainObject(value)) return [`${path} must be an object, got ${describeValue(value)}`];
  const issues: string[] = [];
  for (const [field, kind] of Object.entries(spec.required ?? {})) {
    if (!(field in value)) {
      issues.push(`${path}.${field} is required by the contract and is missing`);
      continue;
    }
    issues.push(...checkField(value[field], kind, `${path}.${field}`));
  }
  for (const [field, kind] of Object.entries(spec.optional ?? {})) {
    if (value[field] === undefined) continue;
    issues.push(...checkField(value[field], kind, `${path}.${field}`));
  }
  return issues;
}

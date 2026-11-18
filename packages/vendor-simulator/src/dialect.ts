import type { SampleObject } from './types';

export type RouteOp = 'list' | 'get' | 'create' | 'update' | 'delete' | 'action';

/** A value the engine computes for a list's envelope field. */
export type EnvelopeValue = 'total' | 'count' | 'page' | 'pageSize' | 'pageCount';

const ENVELOPE_VALUES: readonly EnvelopeValue[] = ['total', 'count', 'page', 'pageSize', 'pageCount'];
/** These describe a page, so the list must always answer one. */
const PAGE_VALUES: readonly EnvelopeValue[] = ['page', 'pageSize', 'pageCount'];

/**
 * An app-supplied list filter for one query parameter, for a vendor syntax the
 * engine does not parse. Returns the matching items, or null when it cannot
 * apply the value, which refuses the request.
 */
export type QueryFunction = (value: string, items: SampleObject[]) => SampleObject[] | null;

/** A child route's parent: the path parameter, the parent's resource, and the child's field holding the parent id. */
export interface ParentRelation {
  param: string;
  resource: string;
  field: string;
}

export interface PlainRoute {
  method: string;
  /** Relative to the dialect base. `:id` captures the object id; a parent's id needs `parent`. */
  path: string;
  op: RouteOp;
  resource: string;
  /** Envelope key for responses; a bare array or object when absent. */
  wrap?: string;
  /** Request body key with the objects; the body itself when absent. */
  bodyKey?: string;
  /** List only. Query parameter to field name; equality on the field's string form. */
  filters?: Record<string, string>;
  /** List only. Query parameter to an app-supplied filter, applied after `filters`. */
  query?: Record<string, QueryFunction>;
  /** List only. Query parameter with `Field`, `Field ASC` or `Field DESC`. */
  sort?: { param: string };
  /**
   * List only. Paged when the parameter is sent, or always with `always`;
   * `first` is the first page number (default 1).
   */
  page?: { param: string; size: number; first?: number; always?: boolean };
  /** List only. A dotted path beside `wrap` to a value the engine computes from the page. */
  envelope?: Record<string, EnvelopeValue>;
  /** For a route under a parent object: its children are scoped to that parent. */
  parent?: ParentRelation;
  /** Create only. An object whose id exists is merged and completed as an update instead of refused. */
  upsert?: boolean;
  /** Action only. Its name, passed to `complete`. */
  action?: string;
  /** Action only. 'object' answers the object, wrapped as a get; 'empty' answers 204 with no body. */
  answer?: 'object' | 'empty';
}

export interface CompleteContext {
  op: 'create' | 'update' | 'action';
  /** The action route's name on an action; undefined otherwise. */
  action: string | undefined;
  /** The stored object on an update or an action; undefined on a create. */
  previous: SampleObject | undefined;
  /** This resource's view, including objects written earlier in the same request. */
  objects: readonly SampleObject[];
  /** The parent id from the path, on a route with a `parent`. */
  parentId: string | undefined;
}

/** Fills what the vendor computes on a write. Returns the object to store. */
export type CompleteFunction = (obj: SampleObject, ctx: CompleteContext) => SampleObject;

/** Fills fields that depend on other resources, on every answer. The result is never stored. */
export type DeriveFunction = (obj: SampleObject, related: Record<string, SampleObject[]>) => SampleObject;

export interface ResourceRules {
  /** Fields the vendor sets that not every seed object shows. Every answered object must carry them. */
  computed?: string[];
  complete?: CompleteFunction;
  /** The resources `derive` reads; each adds one overlay read per request on this resource. */
  uses?: string[];
  derive?: DeriveFunction;
}

export interface PlainDialectOptions {
  /** Path prefix every route sits under, e.g. `/api`. */
  base?: string;
  routes: PlainRoute[];
  /** Per seed resource: what the vendor computes and how the app fills it. */
  resources?: Record<string, ResourceRules>;
  /** Vendor paths no route models, relative to `base`. They answer nothing; a parameter route never takes them. */
  reserved?: string[];
}

export interface RouteMatch {
  route: PlainRoute;
  params: Record<string, string>;
}

export interface Dialect {
  /** The route for this request, or null when it is not simulated. */
  match(method: string, pathname: string): RouteMatch | null;
  /** Per-resource rules; none when absent. */
  resources?: Readonly<Record<string, ResourceRules>>;
  /** The resources a create, update or action route writes, checked against the seed at build. */
  written?: ReadonlySet<string>;
}

const trimSlash = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

const OPS_WITH_ID: readonly RouteOp[] = ['get', 'update', 'delete', 'action'];

/**
 * A route's path parameters must be exactly its own `:id` (get, update, delete, action)
 * plus its declared parent's parameter. Anything else would be matched and then
 * ignored, which answers for the wrong object.
 */
function checkPathParams(route: PlainRoute): void {
  const where = `vendor-simulator: route ${route.method} ${route.path}`;
  const names = trimSlash(route.path)
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));
  const allowed = new Set<string>();
  if (OPS_WITH_ID.includes(route.op)) {
    const article = route.op === 'action' ? 'an' : 'a';
    if (!names.includes('id')) throw new TypeError(`${where}: ${article} ${route.op} route names its object id :id`);
    allowed.add('id');
  }
  if (route.parent) {
    if (route.parent.param === 'id' || !names.includes(route.parent.param)) {
      throw new TypeError(`${where}: parent.param must be a path parameter other than :id`);
    }
    allowed.add(route.parent.param);
  }
  if (new Set(names).size !== names.length) throw new TypeError(`${where}: a path parameter is repeated`);
  const extra = names.filter((n) => !allowed.has(n));
  if (extra.length > 0) {
    throw new TypeError(`${where}: path parameter ${extra.map((n) => `:${n}`).join(', ')} needs a declared parent`);
  }
}

/**
 * An action must say what it is and what it answers, and only `complete` can
 * change its object: without one it would answer unchanged for a call the
 * vendor acts on.
 */
function checkAction(route: PlainRoute, resources: Record<string, ResourceRules>): void {
  const where = `vendor-simulator: route ${route.method} ${route.path}`;
  if (route.op !== 'action') {
    if (route.action !== undefined) throw new TypeError(`${where}: action is for an action route`);
    if (route.answer !== undefined) throw new TypeError(`${where}: answer is for an action route`);
    return;
  }
  if (!route.action) throw new TypeError(`${where}: an action route needs an action name`);
  if (route.answer !== 'object' && route.answer !== 'empty') {
    throw new TypeError(`${where}: an action route needs answer 'object' or 'empty'`);
  }
  if (!resources[route.resource]?.complete) {
    throw new TypeError(`${where}: an action route on resource ${JSON.stringify(route.resource)} needs complete`);
  }
}

/** A page size of 0, or a negative or fractional size or first page, slices on indexes no vendor answers. */
function checkPage(route: PlainRoute): void {
  if (!route.page) return;
  const where = `vendor-simulator: route ${route.method} ${route.path}`;
  const { size, first } = route.page;
  if (!Number.isInteger(size) || size <= 0) throw new TypeError(`${where}: page.size must be a whole number above 0`);
  if (first !== undefined && (!Number.isInteger(first) || first < 0)) {
    throw new TypeError(`${where}: page.first must be a whole number of 0 or more`);
  }
}

/** Every envelope field must be one the engine can compute for every answer of this route. */
function checkEnvelope(route: PlainRoute): void {
  if (route.envelope === undefined) return;
  const where = `vendor-simulator: route ${route.method} ${route.path}`;
  if (route.op !== 'list') throw new TypeError(`${where}: envelope is for a list route`);
  if (!route.wrap) throw new TypeError(`${where}: envelope needs wrap`);
  const paths = Object.keys(route.envelope);
  for (const path of paths) {
    const segments = path.split('.');
    if (segments.some((s) => s === '')) throw new TypeError(`${where}: envelope path ${JSON.stringify(path)} has an empty segment`);
    if (segments[0] === route.wrap) throw new TypeError(`${where}: envelope path ${JSON.stringify(path)} starts at the wrap key`);
    const value = route.envelope[path];
    if (value === undefined || !ENVELOPE_VALUES.includes(value)) {
      throw new TypeError(`${where}: ${JSON.stringify(value)} is not an envelope value`);
    }
    if (PAGE_VALUES.includes(value) && !route.page?.always) {
      throw new TypeError(`${where}: envelope value ${JSON.stringify(value)} needs page.always`);
    }
  }
  for (const a of paths) {
    const b = paths.find((p) => p.startsWith(`${a}.`));
    if (b !== undefined) throw new TypeError(`${where}: envelope paths ${JSON.stringify(a)} and ${JSON.stringify(b)} overlap`);
  }
}

/** A declared computed field must have something to fill it, and `derive` is what reads `uses`. */
function checkResourceRules(resource: string, rules: ResourceRules): void {
  const where = `vendor-simulator: resource ${JSON.stringify(resource)}`;
  if ((rules.computed?.length ?? 0) > 0 && !rules.complete && !rules.derive) {
    throw new TypeError(`${where}: computed fields need complete or derive`);
  }
  if (rules.uses !== undefined && !rules.derive) throw new TypeError(`${where}: uses needs derive`);
}

/** A route's or reserved path's segments, and its shape: the segments with every parameter as `:`. */
interface Pattern {
  path: string;
  parts: string[];
  shape: string;
}

function pattern(path: string): Pattern {
  const parts = trimSlash(path).split('/');
  return { path, parts, shape: parts.map((p) => (p.startsWith(':') ? ':' : p)).join('/') };
}

const isParam = (segment: string): boolean => segment.startsWith(':');

/** Whether a pattern fits decoded request segments; a segment that did not decode fits nothing. */
function fits(p: Pattern, segments: Array<string | null>): boolean {
  if (p.parts.length !== segments.length) return false;
  return p.parts.every((want, i) => {
    const got = segments[i];
    if (got === null || got === undefined) return false;
    return isParam(want) ? got !== '' : got === want;
  });
}

/** Of two patterns that fit one request, `a` is more specific when it has a literal where `b` first has a parameter. */
function moreSpecific(a: Pattern, b: Pattern): boolean {
  for (let i = 0; i < a.parts.length; i++) {
    const aLiteral = !isParam(a.parts[i] ?? '');
    const bLiteral = !isParam(b.parts[i] ?? '');
    if (aLiteral !== bLiteral) return aLiteral;
  }
  return false;
}

/**
 * A reserved path that is also a route, or two routes one request could reach
 * on one method, would leave a request answered by whichever was declared first.
 */
function checkShapes(routes: Array<Pattern & { method: string }>, reserved: Pattern[]): void {
  for (const r of reserved) {
    if (!r.path.startsWith('/')) throw new TypeError(`vendor-simulator: reserved path ${r.path} must start with /`);
    const names = r.parts.filter(isParam);
    if (new Set(names).size !== names.length) throw new TypeError(`vendor-simulator: reserved path ${r.path} repeats a parameter`);
    if (routes.some((c) => c.shape === r.shape)) throw new TypeError(`vendor-simulator: reserved path ${r.path} is also a route`);
  }
  routes.forEach((a, i) => {
    const b = routes.slice(i + 1).find((c) => c.method === a.method && c.shape === a.shape);
    if (b) {
      throw new TypeError(`vendor-simulator: routes ${a.method} ${a.path} and ${b.method} ${b.path} match the same requests`);
    }
  });
}

/** A REST-style dialect: method plus path pattern, JSON bodies, query filters, sort and paging. */
export function plainDialect({ base = '', routes, resources = {}, reserved = [] }: PlainDialectOptions): Dialect {
  const root = trimSlash(base) === '/' ? '' : trimSlash(base);
  for (const route of routes) {
    checkPathParams(route);
    if (route.upsert && route.op !== 'create') {
      throw new TypeError(`vendor-simulator: route ${route.method} ${route.path}: upsert is for a create route`);
    }
    checkAction(route, resources);
    checkPage(route);
    checkEnvelope(route);
  }
  for (const [resource, rules] of Object.entries(resources)) checkResourceRules(resource, rules);
  const writes: readonly RouteOp[] = ['create', 'update', 'action'];
  const written = new Set(routes.filter((r) => writes.includes(r.op)).map((r) => r.resource));
  const compiled = routes.map((route) => ({ route, method: route.method.toUpperCase(), ...pattern(route.path) }));
  const reservedPatterns = reserved.map(pattern);
  checkShapes(compiled, reservedPatterns);
  const patterns: Pattern[] = [...compiled, ...reservedPatterns];

  return {
    resources,
    written,
    match(method: string, pathname: string): RouteMatch | null {
      if (root && pathname !== root && !pathname.startsWith(`${root}/`)) return null;
      const segments = trimSlash(pathname.slice(root.length) || '/').split('/').map(decodeSegment);
      // The path is matched before the method: the most specific pattern decides which route may answer.
      let best: Pattern | null = null;
      for (const p of patterns) {
        if (fits(p, segments) && (best === null || moreSpecific(p, best))) best = p;
      }
      if (best === null) return null;
      const shape = best.shape;
      const hit = compiled.find((c) => c.method === method.toUpperCase() && c.shape === shape);
      if (!hit) return null;
      const params: Record<string, string> = {};
      hit.parts.forEach((want, i) => {
        if (isParam(want)) params[want.slice(1)] = segments[i] ?? '';
      });
      return { route: hit.route, params };
    },
  };
}

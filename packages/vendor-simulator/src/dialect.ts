import type { SampleObject } from './types';

export type RouteOp = 'list' | 'get' | 'create' | 'update' | 'delete';

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
  /** List only. Paged only when the parameter is sent; `first` is the first page number (default 1). */
  page?: { param: string; size: number; first?: number };
  /** For a route under a parent object: its children are scoped to that parent. */
  parent?: ParentRelation;
  /** Create only. An object whose id exists is merged and completed as an update instead of refused. */
  upsert?: boolean;
}

export interface CompleteContext {
  op: 'create' | 'update';
  /** The stored object on an update; undefined on a create. */
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
  /** The resources a create or update route writes, checked against the seed at build. */
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

const OPS_WITH_ID: readonly RouteOp[] = ['get', 'update', 'delete'];

/**
 * A route's path parameters must be exactly its own `:id` (get, update, delete)
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
    if (!names.includes('id')) throw new TypeError(`${where}: a ${route.op} route names its object id :id`);
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

/** A declared computed field must have something to fill it, and `derive` is what reads `uses`. */
function checkResourceRules(resource: string, rules: ResourceRules): void {
  const where = `vendor-simulator: resource ${JSON.stringify(resource)}`;
  if ((rules.computed?.length ?? 0) > 0 && !rules.complete && !rules.derive) {
    throw new TypeError(`${where}: computed fields need complete or derive`);
  }
  if (rules.uses !== undefined && !rules.derive) throw new TypeError(`${where}: uses needs derive`);
}

/** A REST-style dialect: method plus path pattern, JSON bodies, query filters, sort and paging. */
export function plainDialect({ base = '', routes, resources = {} }: PlainDialectOptions): Dialect {
  const root = trimSlash(base) === '/' ? '' : trimSlash(base);
  for (const route of routes) {
    checkPathParams(route);
    if (route.upsert && route.op !== 'create') {
      throw new TypeError(`vendor-simulator: route ${route.method} ${route.path}: upsert is for a create route`);
    }
  }
  for (const [resource, rules] of Object.entries(resources)) checkResourceRules(resource, rules);
  const written = new Set(routes.filter((r) => r.op === 'create' || r.op === 'update').map((r) => r.resource));
  const compiled = routes.map((route) => ({
    route,
    method: route.method.toUpperCase(),
    parts: trimSlash(route.path).split('/'),
  }));

  return {
    resources,
    written,
    match(method: string, pathname: string): RouteMatch | null {
      if (root && pathname !== root && !pathname.startsWith(`${root}/`)) return null;
      const parts = trimSlash(pathname.slice(root.length) || '/').split('/');
      const m = method.toUpperCase();
      for (const c of compiled) {
        if (c.method !== m || c.parts.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < parts.length && ok; i++) {
          const want = c.parts[i] ?? '';
          const got = parts[i] ?? '';
          if (want.startsWith(':')) {
            const value = got ? decodeSegment(got) : null;
            if (value === null) ok = false;
            else params[want.slice(1)] = value;
          } else if (want !== got) {
            ok = false;
          }
        }
        if (ok) return { route: c.route, params };
      }
      return null;
    },
  };
}

export type RouteOp = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface PlainRoute {
  method: string;
  /** Relative to the dialect base; a `:name` segment captures the object id. */
  path: string;
  op: RouteOp;
  resource: string;
  /** Envelope key for responses; a bare array or object when absent. */
  wrap?: string;
  /** Request body key with the objects; the body itself when absent. */
  bodyKey?: string;
  /** Query parameter to field name; equality on the field's string form. */
  filters?: Record<string, string>;
  /** Query parameter with `Field` or `Field DESC`. */
  sort?: { param: string };
  /** Paged only when the parameter is sent; `first` is the first page number (default 1). */
  page?: { param: string; size: number; first?: number };
}

export interface PlainDialectOptions {
  /** Path prefix every route sits under, e.g. `/api`. */
  base?: string;
  routes: PlainRoute[];
}

export interface RouteMatch {
  route: PlainRoute;
  params: Record<string, string>;
}

export interface Dialect {
  /** The route for this request, or null when it is not simulated. */
  match(method: string, pathname: string): RouteMatch | null;
}

const trimSlash = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** A REST-style dialect: method plus path pattern, JSON bodies, query filters, sort and paging. */
export function plainDialect({ base = '', routes }: PlainDialectOptions): Dialect {
  const root = trimSlash(base) === '/' ? '' : trimSlash(base);
  const compiled = routes.map((route) => ({
    route,
    method: route.method.toUpperCase(),
    parts: trimSlash(route.path).split('/'),
  }));

  return {
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

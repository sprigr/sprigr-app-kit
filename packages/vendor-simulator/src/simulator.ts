import type { Dialect, PlainRoute } from './dialect';
import { NotSimulatedError, type NotSimulatedReason } from './errors';
import type { FetchImpl, SampleObject, SampleSeed, SampleStore } from './types';

export interface SimulatorOptions {
  /** Shipped read-only in the app bundle; never written. */
  seed: SampleSeed;
  dialect: Dialect;
  /** This install's overlay of writes. */
  store: SampleStore;
}

export interface Simulator {
  fetch: FetchImpl;
}

const isObject = (v: unknown): v is SampleObject => typeof v === 'object' && v !== null && !Array.isArray(v);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = (): Response => new Response(null, { status: 404 });
const badRequest = (): Response => new Response(null, { status: 400 });

/** Thrown inside one request; `simulate` turns it into NotSimulatedError with the method and path. */
class Refusal extends Error {
  constructor(readonly reason: NotSimulatedReason) {
    super(reason);
  }
}

/** Numbers compare as numbers, everything else as strings; missing values sort last. */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const mediaType = (value: string): string => (value.split(';')[0] ?? '').trim().toLowerCase();
const isJsonType = (type: string): boolean => type === 'application/json' || /^application\/[^/]+\+json$/.test(type);
/** No declared type (a plain string body) is read as JSON, as before; anything else must be a JSON type. */
const isJsonBody = (type: string | null): boolean => type === null || isJsonType(type);

/** Whether the most preferred range of an Accept header admits JSON: highest q wins, the first on a tie, q=0 never. */
function acceptsJson(accept: string | null): boolean {
  if (accept === null || accept.trim() === '') return true;
  let best: { type: string; q: number } | null = null;
  for (const range of accept.split(',')) {
    const [rawType, ...rawParams] = range.split(';');
    const type = (rawType ?? '').trim().toLowerCase();
    if (!type) continue;
    const qParam = rawParams.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const parsed = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2));
    const q = Number.isNaN(parsed) ? 1 : parsed;
    if (q <= 0) continue;
    if (best === null || q > best.q) best = { type, q };
  }
  if (best === null) return false;
  return best.type === '*/*' || best.type === 'application/*' || isJsonType(best.type);
}

/** The body's media type: the header when set, else what the body itself carries; null for a plain string or no body. */
function bodyType(headers: Headers, req: Request | null, init?: RequestInit): string | null {
  const header = headers.get('content-type');
  if (header !== null && header.trim() !== '') return mediaType(header);
  const raw = init?.body ?? null;
  if (raw instanceof FormData) return 'multipart/form-data';
  if (raw instanceof URLSearchParams) return 'application/x-www-form-urlencoded';
  if (raw instanceof Blob && raw.type) return mediaType(raw.type);
  if (raw === null && req) {
    const fromReq = req.headers.get('content-type');
    if (fromReq) return mediaType(fromReq);
  }
  return null;
}

async function bodyText(req: Request | null, init?: RequestInit): Promise<string> {
  const raw = init?.body;
  if (typeof raw === 'string') return raw;
  if (raw !== undefined && raw !== null) return new Response(raw as ConstructorParameters<typeof Response>[0]).text();
  return req ? req.clone().text() : '';
}

async function readJson(req: Request | null, init?: RequestInit): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await bodyText(req, init)) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The objects a write carries: under `bodyKey` when set, else the body itself. */
function bodyObjects(route: PlainRoute, body: unknown): SampleObject[] | null {
  let raw: unknown = body;
  if (route.bodyKey) {
    if (!isObject(body)) return null;
    raw = body[route.bodyKey];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.every(isObject) ? list : null;
}

const SORT_VALUE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?$/i;
const PAGE_VALUE = /^\d+$/;

/**
 * Every query parameter must be one the route declares, sent once, with a value
 * the engine can apply. Only a list declares any. Checked before the overlay read.
 */
function checkQuery(route: PlainRoute, query: URLSearchParams): void {
  const declared = new Set<string>();
  if (route.op === 'list') {
    for (const p of Object.keys(route.filters ?? {})) declared.add(p);
    for (const p of Object.keys(route.query ?? {})) declared.add(p);
    if (route.sort) declared.add(route.sort.param);
    if (route.page) declared.add(route.page.param);
  }
  for (const name of new Set(query.keys())) {
    if (!declared.has(name) || query.getAll(name).length > 1) throw new Refusal('query');
  }
  const order = route.sort ? query.get(route.sort.param) : null;
  if (order !== null && !SORT_VALUE.test(order.trim())) throw new Refusal('query');
  const page = route.page ? query.get(route.page.param) : null;
  if (route.page && page !== null && (!PAGE_VALUE.test(page) || Number(page) < (route.page.first ?? 1))) {
    throw new Refusal('query');
  }
}

/** Filters, then the app's query functions, then sort, then page. Values were checked by `checkQuery`. */
function listView(route: PlainRoute, all: SampleObject[], query: URLSearchParams): SampleObject[] {
  let items = all;
  for (const [param, field] of Object.entries(route.filters ?? {})) {
    const want = query.get(param);
    if (want !== null) items = items.filter((i) => String(i[field] ?? '') === want);
  }
  for (const [param, apply] of Object.entries(route.query ?? {})) {
    const value = query.get(param);
    if (value === null) continue;
    const kept = apply(value, items);
    if (kept === null) throw new Refusal('query');
    items = kept;
  }
  const order = route.sort ? query.get(route.sort.param) : null;
  const sortMatch = order === null ? null : SORT_VALUE.exec(order.trim());
  if (sortMatch) {
    const field = sortMatch[1] ?? '';
    const sign = sortMatch[2]?.toUpperCase() === 'DESC' ? -1 : 1;
    items = [...items].sort((a, b) => sign * compare(a[field], b[field]));
  }
  const page = route.page ? query.get(route.page.param) : null;
  if (route.page && page !== null) {
    const index = Number(page) - (route.page.first ?? 1);
    const size = route.page.size;
    items = items.slice(index * size, index * size + size);
  }
  return items;
}

/**
 * Answers a vendor request from the seed plus this install's overlay. A request
 * the engine does not model throws NotSimulatedError before any write; nothing
 * reaches the network.
 */
export function createSimulator({ seed, dialect, store }: SimulatorOptions): Simulator {
  async function view(resource: string): Promise<{ idField: string; objects: Map<string, SampleObject> }> {
    const source = seed[resource];
    if (!source) throw new Error(`vendor-simulator: the seed has no resource ${JSON.stringify(resource)}`);
    const objects = new Map<string, SampleObject>();
    for (const item of source.items) objects.set(String(item[source.idField]), { ...item });
    for (const row of await store.listOverlay(resource)) {
      if (row.deleted) objects.delete(row.id);
      else objects.set(row.id, JSON.parse(row.body) as SampleObject);
    }
    return { idField: source.idField, objects };
  }

  async function answer(route: PlainRoute, params: Record<string, string>, url: URL, req: Request | null, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers ?? req?.headers);
    if (!acceptsJson(headers.get('accept'))) throw new Refusal('accept');
    if ((route.op === 'create' || route.op === 'update') && !isJsonBody(bodyType(headers, req, init))) {
      throw new Refusal('content_type');
    }
    checkQuery(route, url.searchParams);

    // A child is reachable only through a parent that exists, and only its own.
    let parentId: string | undefined;
    if (route.parent) {
      parentId = params[route.parent.param];
      const parents = await view(route.parent.resource);
      if (parentId === undefined || !parents.objects.has(parentId)) return notFound();
    }
    const parentField = route.parent?.field;
    const ownChild = (obj: SampleObject | undefined): SampleObject | undefined =>
      obj && (parentField === undefined || String(obj[parentField] ?? '') === parentId) ? obj : undefined;
    const namesOtherParent = (obj: SampleObject): boolean =>
      parentField !== undefined && obj[parentField] !== undefined && String(obj[parentField]) !== parentId;

    const { idField, objects } = await view(route.resource);
    const id = params.id;
    const one = (obj: SampleObject): unknown => (route.wrap ? { [route.wrap]: [obj] } : obj);

    switch (route.op) {
      case 'list': {
        const all = [...objects.values()].filter((o) => ownChild(o) !== undefined);
        const items = listView(route, all, url.searchParams);
        return json(route.wrap ? { [route.wrap]: items } : items);
      }
      case 'get': {
        const obj = id === undefined ? undefined : ownChild(objects.get(id));
        return obj ? json(one(obj)) : notFound();
      }
      case 'create': {
        const body = await readJson(req, init);
        const incoming = body.ok ? bodyObjects(route, body.value) : null;
        if (!body.ok || !incoming) return badRequest();
        // All or nothing: no object in the batch may name, or by its id take over, another parent's child.
        const takesOtherChild = (obj: SampleObject): boolean => {
          const given = obj[idField];
          if (parentField === undefined || (typeof given !== 'string' && typeof given !== 'number')) return false;
          const existing = objects.get(String(given));
          return existing !== undefined && ownChild(existing) === undefined;
        };
        if (incoming.some((obj) => namesOtherParent(obj) || takesOtherChild(obj))) throw new Refusal('parent');
        const created: SampleObject[] = [];
        for (const obj of incoming) {
          const given = obj[idField];
          const newId = typeof given === 'string' || typeof given === 'number' ? String(given) : crypto.randomUUID();
          const scoped = parentField === undefined ? obj : { ...obj, [parentField]: obj[parentField] ?? parentId };
          const stored = { ...scoped, [idField]: given ?? newId };
          await store.put(route.resource, newId, stored);
          created.push(stored);
        }
        if (route.wrap) return json({ [route.wrap]: created });
        return json(created.length === 1 && !route.bodyKey && body.ok && !Array.isArray(body.value) ? created[0] : created);
      }
      case 'update': {
        const existing = id === undefined ? undefined : ownChild(objects.get(id));
        if (id === undefined || !existing) return notFound();
        const body = await readJson(req, init);
        const patch = body.ok ? bodyObjects(route, body.value)?.[0] : undefined;
        if (!patch) return badRequest();
        if (namesOtherParent(patch)) throw new Refusal('parent');
        const merged = { ...existing, ...patch, [idField]: existing[idField] };
        await store.put(route.resource, id, merged);
        return json(one(merged));
      }
      case 'delete': {
        if (id === undefined || !ownChild(objects.get(id))) return notFound();
        await store.put(route.resource, id, null);
        return new Response(null, { status: 204 });
      }
      default:
        throw new Refusal('no_route');
    }
  }

  async function simulate(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const hit = dialect.match(method, url.pathname);
    if (!hit) throw new NotSimulatedError(method, url.pathname, 'no_route');
    try {
      return await answer(hit.route, hit.params, url, req, init);
    } catch (err) {
      if (err instanceof Refusal) throw new NotSimulatedError(method, url.pathname, err.reason);
      throw err;
    }
  }

  return { fetch: simulate };
}

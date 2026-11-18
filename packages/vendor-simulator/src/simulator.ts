import type { Dialect, PlainRoute } from './dialect';
import { NotSimulatedError } from './errors';
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

function listView(route: PlainRoute, all: SampleObject[], query: URLSearchParams): SampleObject[] {
  let items = all;
  for (const [param, field] of Object.entries(route.filters ?? {})) {
    const want = query.get(param);
    if (want !== null) items = items.filter((i) => String(i[field] ?? '') === want);
  }
  const order = route.sort ? query.get(route.sort.param) : null;
  if (order) {
    const [field, dir] = order.trim().split(/\s+/);
    if (field) {
      const sign = dir?.toUpperCase() === 'DESC' ? -1 : 1;
      items = [...items].sort((a, b) => sign * compare(a[field], b[field]));
    }
  }
  const pageParam = route.page ? query.get(route.page.param) : null;
  if (route.page && pageParam !== null) {
    const index = Number.parseInt(pageParam, 10) - (route.page.first ?? 1);
    const size = route.page.size;
    items = Number.isInteger(index) && index >= 0 ? items.slice(index * size, index * size + size) : [];
  }
  return items;
}

/**
 * Answers a vendor request from the seed plus this install's overlay. A request
 * the dialect does not route throws NotSimulatedError; nothing reaches the network.
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

  async function simulate(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const hit = dialect.match(method, url.pathname);
    if (!hit) throw new NotSimulatedError(method, url.pathname);

    const { route, params } = hit;
    const { idField, objects } = await view(route.resource);
    const id = params.id ?? Object.values(params)[0];
    const one = (obj: SampleObject): unknown => (route.wrap ? { [route.wrap]: [obj] } : obj);

    switch (route.op) {
      case 'list': {
        const items = listView(route, [...objects.values()], url.searchParams);
        return json(route.wrap ? { [route.wrap]: items } : items);
      }
      case 'get': {
        const obj = id === undefined ? undefined : objects.get(id);
        return obj ? json(one(obj)) : notFound();
      }
      case 'create': {
        const body = await readJson(req, init);
        const incoming = body.ok ? bodyObjects(route, body.value) : null;
        if (!body.ok || !incoming) return badRequest();
        const created: SampleObject[] = [];
        for (const obj of incoming) {
          const given = obj[idField];
          const newId = typeof given === 'string' || typeof given === 'number' ? String(given) : crypto.randomUUID();
          const stored = { ...obj, [idField]: given ?? newId };
          await store.put(route.resource, newId, stored);
          created.push(stored);
        }
        if (route.wrap) return json({ [route.wrap]: created });
        return json(created.length === 1 && !route.bodyKey && body.ok && !Array.isArray(body.value) ? created[0] : created);
      }
      case 'update': {
        const existing = id === undefined ? undefined : objects.get(id);
        if (id === undefined || !existing) return notFound();
        const body = await readJson(req, init);
        const patch = body.ok ? bodyObjects(route, body.value)?.[0] : undefined;
        if (!patch) return badRequest();
        const merged = { ...existing, ...patch, [idField]: existing[idField] };
        await store.put(route.resource, id, merged);
        return json(one(merged));
      }
      case 'delete': {
        if (id === undefined || !objects.has(id)) return notFound();
        await store.put(route.resource, id, null);
        return new Response(null, { status: 204 });
      }
      default:
        throw new NotSimulatedError(method, url.pathname);
    }
  }

  return { fetch: simulate };
}

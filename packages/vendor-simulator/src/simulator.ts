import type { CompleteContext, Dialect, PlainRoute, ResourceRules } from './dialect';
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
  constructor(
    readonly reason: NotSimulatedReason,
    options?: { cause?: unknown },
  ) {
    super(reason, options);
  }
}

/** Runs app-supplied code. A throw is refused as `computed`, keeping the throw as the cause. */
function appCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Refusal('computed', { cause: err });
  }
}

/** An id the engine can key, store and answer: a non-empty string or a finite number. */
const usableId = (v: unknown): v is string | number =>
  (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v));

/** App code may not change these: the id, and on a parented route the parent field. */
function restore(out: SampleObject, from: SampleObject, fixed: readonly string[]): SampleObject {
  const kept: SampleObject = { ...out };
  for (const field of fixed) kept[field] = from[field];
  return kept;
}

/** The object to store: the app's completion when there is one, with the fixed fields restored. */
function completeObject(rules: ResourceRules | undefined, base: SampleObject, ctx: CompleteContext, fixed: readonly string[]): SampleObject {
  const complete = rules?.complete;
  if (!complete) return base;
  const out = appCall(() => complete({ ...base }, ctx));
  if (!isObject(out)) throw new Refusal('computed');
  return restore(out, base, fixed);
}

/** A new object's id: the resource's `newId` when it has one, else a UUID. */
function mintId(rules: ResourceRules | undefined, objects: readonly SampleObject[], parentId: string | undefined): string | number {
  const newId = rules?.newId;
  if (!newId) return crypto.randomUUID();
  const id: unknown = appCall(() => newId({ objects, parentId }));
  if (usableId(id)) return id;
  throw new Refusal('computed');
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

/** A list's answer: the page's items, the count matched before paging, and the page number when paged. */
interface ListPage {
  items: SampleObject[];
  total: number;
  page: number | null;
}

/** Filters, then the app's query functions, then sort, then page. Values were checked by `checkQuery`. */
function listView(route: PlainRoute, all: SampleObject[], query: URLSearchParams): ListPage {
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
  const total = items.length;
  const sent = route.page ? query.get(route.page.param) : null;
  const first = route.page?.first ?? 1;
  const page = sent !== null ? Number(sent) : route.page?.always ? first : null;
  if (route.page && page !== null) {
    const index = page - first;
    const size = route.page.size;
    items = items.slice(index * size, index * size + size);
  }
  return { items, total, page };
}

/** The route's envelope fields, each computed from the page; the build guarantees each is computable. */
function envelopeOf(route: PlainRoute, view: ListPage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const size = route.page?.size ?? 0;
  for (const [path, token] of Object.entries(route.envelope ?? {})) {
    const value =
      token === 'total' ? view.total
      : token === 'count' ? view.items.length
      : token === 'page' ? view.page
      : token === 'pageSize' ? size
      : Math.ceil(view.total / size);
    const segments = path.split('.');
    const last = segments.pop() ?? path;
    let node = out;
    for (const segment of segments) {
      let next = node[segment] as Record<string, unknown> | undefined;
      if (next === undefined) {
        next = {};
        node[segment] = next;
      }
      node = next;
    }
    node[last] = value;
  }
  return out;
}

/**
 * Answers a vendor request from the seed plus this install's overlay. A request
 * the engine does not model throws NotSimulatedError before any write; nothing
 * reaches the network.
 */
export function createSimulator({ seed, dialect, store }: SimulatorOptions): Simulator {
  const rules: Readonly<Record<string, ResourceRules>> = dialect.resources ?? {};

  // The store keys objects by String(id): an unusable id is unreachable or answered wrong, and a repeat hides the earlier object.
  for (const [resource, source] of Object.entries(seed)) {
    const seen = new Map<string, number>();
    source.items.forEach((item, i) => {
      const id = item[source.idField];
      if (!usableId(id)) {
        const shown = typeof id === 'number' ? String(id) : (JSON.stringify(id) ?? String(id));
        throw new TypeError(`vendor-simulator: resource ${JSON.stringify(resource)}: seed object ${i} has ${source.idField} ${shown}, which is not a usable id`);
      }
      const earlier = seen.get(String(id));
      if (earlier !== undefined) {
        throw new TypeError(`vendor-simulator: resource ${JSON.stringify(resource)}: seed objects ${earlier} and ${i} have the same ${source.idField} ${JSON.stringify(String(id))}`);
      }
      seen.set(String(id), i);
    });
  }

  // What every answered object must carry: each key every seed object of its resource
  // has as an own property (null included), plus the declared computed fields. Once, at build.
  const required = new Map<string, string[]>();
  for (const [resource, source] of Object.entries(seed)) {
    const [first, ...rest] = source.items;
    const shape = first ? Object.keys(first).filter((k) => rest.every((item) => Object.hasOwn(item, k))) : [];
    required.set(resource, [...new Set([...shape, ...(rules[resource]?.computed ?? [])])]);
  }
  const requiredFor = (resource: string): string[] => required.get(resource) ?? rules[resource]?.computed ?? [];

  for (const resource of dialect.written ?? []) {
    if (seed[resource]?.items.length === 0 && rules[resource]?.computed === undefined) {
      throw new TypeError(`vendor-simulator: resource ${JSON.stringify(resource)} is written but its seed has no objects; declare its computed fields`);
    }
  }
  for (const [resource, r] of Object.entries(rules)) {
    // A name the seed does not have would never apply, and the answers would lack what it computes.
    if (!Object.hasOwn(seed, resource)) {
      throw new TypeError(`vendor-simulator: resources names ${JSON.stringify(resource)}, which is not a seed resource`);
    }
    const unknownUses = (r.uses ?? []).filter((u) => !Object.hasOwn(seed, u));
    if (unknownUses.length > 0) {
      throw new TypeError(`vendor-simulator: resource ${JSON.stringify(resource)} uses ${unknownUses.join(', ')}, which is not a seed resource`);
    }
    if (r.derive) continue;
    const missing = (r.computed ?? []).filter((f) => seed[resource]?.items.some((item) => !Object.hasOwn(item, f)));
    if (missing.length > 0) {
      throw new TypeError(`vendor-simulator: resource ${JSON.stringify(resource)}: seed objects lack computed ${missing.join(', ')} and no derive fills them on a read`);
    }
  }

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
    // An action takes no body: a JSON one is refused too, so it is not `content_type`.
    if (route.op === 'action' && (await bodyText(req, init)) !== '') throw new Refusal('body');
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
    // A parent field equal only as a string, such as ["p1"], names no parent.
    const namesOtherParent = (obj: SampleObject): boolean =>
      parentField !== undefined &&
      obj[parentField] !== undefined &&
      !(usableId(obj[parentField]) && String(obj[parentField]) === parentId);

    const { idField, objects } = await view(route.resource);
    const id = params.id;
    const one = (obj: SampleObject): unknown => (route.wrap ? { [route.wrap]: [obj] } : obj);
    const resourceRules = rules[route.resource];

    // Every answered object is derived, then checked; a delete answers no object.
    const related: Record<string, SampleObject[]> = {};
    if (route.op !== 'delete') {
      for (const u of resourceRules?.uses ?? []) related[u] = [...(await view(u)).objects.values()];
    }
    const fixed = parentField === undefined ? [idField] : [idField, parentField];
    const deriveFn = resourceRules?.derive;
    const derive = (obj: SampleObject): SampleObject => {
      if (!deriveFn) return obj;
      const out = appCall(() => deriveFn({ ...obj }, related));
      if (!isObject(out)) throw new Refusal('computed');
      return restore(out, obj, fixed);
    };
    const fields = requiredFor(route.resource);
    const check = (obj: SampleObject): SampleObject => {
      if (fields.some((f) => !Object.hasOwn(obj, f))) throw new Refusal('computed');
      return obj;
    };

    switch (route.op) {
      case 'list': {
        const all = [...objects.values()].filter((o) => ownChild(o) !== undefined).map(derive);
        const page = listView(route, all, url.searchParams);
        const items = page.items.map(check);
        return json(route.wrap ? { [route.wrap]: items, ...envelopeOf(route, page) } : items);
      }
      case 'get': {
        const obj = id === undefined ? undefined : ownChild(objects.get(id));
        return obj ? json(one(check(derive(obj)))) : notFound();
      }
      case 'create': {
        const body = await readJson(req, init);
        const incoming = body.ok ? bodyObjects(route, body.value) : null;
        if (!body.ok || !incoming) return badRequest();
        // All or nothing: no object in the batch may name, or by its id take over, another parent's child.
        const takesOtherChild = (obj: SampleObject): boolean => {
          const given = obj[idField];
          if (parentField === undefined || !usableId(given)) return false;
          const existing = objects.get(String(given));
          return existing !== undefined && ownChild(existing) === undefined;
        };
        // A body id the engine cannot key or answer as sent: what the vendor does with it is not modelled.
        if (incoming.some((obj) => obj[idField] != null && !usableId(obj[idField]))) throw new Refusal('id');
        if (incoming.some((obj) => namesOtherParent(obj) || takesOtherChild(obj))) throw new Refusal('parent');
        // Every object is completed and checked before the first write.
        const working = new Map(objects);
        const planned: Array<[string, SampleObject]> = [];
        const answered: SampleObject[] = [];
        for (const obj of incoming) {
          const given = obj[idField];
          const previous = usableId(given) ? working.get(String(given)) : undefined;
          if (previous && !route.upsert) throw new Refusal('exists');
          const minted = usableId(given) ? undefined : mintId(resourceRules, [...working.values()], parentId);
          const newId = String(minted ?? given);
          if (minted !== undefined && working.has(newId)) throw new Refusal('exists');
          const scoped = parentField === undefined ? obj : { ...obj, [parentField]: obj[parentField] ?? parentId };
          const base = previous ? { ...previous, ...obj, [idField]: previous[idField] } : { ...scoped, [idField]: given ?? minted };
          const ctx = { op: previous ? 'update' : 'create', action: undefined, previous, objects: [...working.values()], parentId } as const;
          const stored = completeObject(resourceRules, base, ctx, fixed);
          answered.push(check(derive(stored)));
          working.set(newId, stored);
          planned.push([newId, stored]);
        }
        for (const [key, stored] of planned) await store.put(route.resource, key, stored);
        if (route.wrap) return json({ [route.wrap]: answered });
        return json(answered.length === 1 && !route.bodyKey && !Array.isArray(body.value) ? answered[0] : answered);
      }
      case 'update': {
        const existing = id === undefined ? undefined : ownChild(objects.get(id));
        if (id === undefined || !existing) return notFound();
        const body = await readJson(req, init);
        const patch = body.ok ? bodyObjects(route, body.value)?.[0] : undefined;
        if (!patch) return badRequest();
        if (namesOtherParent(patch)) throw new Refusal('parent');
        const merged = { ...existing, ...patch, [idField]: existing[idField] };
        const ctx = { op: 'update', action: undefined, previous: existing, objects: [...objects.values()], parentId } as const;
        const stored = completeObject(resourceRules, merged, ctx, fixed);
        const answer = check(derive(stored));
        await store.put(route.resource, id, stored);
        return json(one(answer));
      }
      case 'action': {
        const existing = id === undefined ? undefined : ownChild(objects.get(id));
        if (id === undefined || !existing) return notFound();
        const ctx = { op: 'action', action: route.action, previous: existing, objects: [...objects.values()], parentId } as const;
        const stored = completeObject(resourceRules, existing, ctx, fixed);
        const answer = check(derive(stored));
        // An action that changes nothing costs no write.
        if (JSON.stringify(stored) !== JSON.stringify(existing)) await store.put(route.resource, id, stored);
        return route.answer === 'empty' ? new Response(null, { status: 204 }) : json(one(answer));
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
      if (err instanceof Refusal) {
        throw new NotSimulatedError(method, url.pathname, err.reason, err.cause === undefined ? undefined : { cause: err.cause });
      }
      throw err;
    }
  }

  return { fetch: simulate };
}

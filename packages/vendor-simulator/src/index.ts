/**
 * Vendor simulator: answers an app's vendor requests from a shipped seed plus a
 * per-install overlay while the install is in sample mode.
 *
 * Stub only: the exported names and types, every body throws. The behaviour
 * lands in the next commit.
 */

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** on: answer from the simulator. off: the real vendor. unknown: refuse both. */
export type SampleMode = 'on' | 'off' | 'unknown';

/** The flag row lives in the overlay table under a resource no app uses. */
export const SAMPLE_FLAG_RESOURCE = '__sample_mode__';
export const SAMPLE_FLAG_ID = 'flag';

export interface OverlayRow {
  id: string;
  body: string;
  deleted: boolean;
}

export interface SampleStore {
  isOn(): Promise<boolean>;
  setOn(): Promise<void>;
  listOverlay(resource: string): Promise<OverlayRow[]>;
  put(resource: string, id: string, body: Record<string, unknown> | null): Promise<void>;
  clear(): Promise<void>;
}

export interface SampleStoreOptions {
  db: D1Database;
  table: string;
}

export function createSampleStore(opts: SampleStoreOptions): SampleStore {
  void opts;
  throw new Error('not implemented');
}

export interface SampleSwitch {
  mode(): Promise<SampleMode>;
}

export function createSampleSwitch(store: SampleStore): SampleSwitch {
  void store;
  throw new Error('not implemented');
}

export class SampleModeUnknownError extends Error {
  declare readonly code: 'sample_mode_unknown';
  constructor() {
    super();
    throw new Error('not implemented');
  }
}

export class NotSimulatedError extends Error {
  declare readonly code: 'not_simulated';
  declare readonly method: string;
  declare readonly path: string;
  constructor(method: string, path: string) {
    super();
    void method;
    void path;
    throw new Error('not implemented');
  }
}

export interface SeedResource {
  idField: string;
  items: Array<Record<string, unknown>>;
}

export type SampleSeed = Record<string, SeedResource>;

export type RouteOp = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface PlainRoute {
  method: string;
  /** Relative to the dialect base; `:id` names the object id segment. */
  path: string;
  op: RouteOp;
  resource: string;
  /** Envelope key for responses; a bare array or object when absent. */
  wrap?: string;
  /** Request body key holding an array of objects; the body is one object when absent. */
  bodyKey?: string;
  /** Query parameter to field name. */
  filters?: Record<string, string>;
  /** Query parameter holding `Field` or `Field DESC`. */
  sort?: { param: string };
  /** Paged only when the parameter is sent. */
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

export function plainDialect(opts: PlainDialectOptions): Dialect {
  void opts;
  throw new Error('not implemented');
}

export interface SimulatorOptions {
  seed: SampleSeed;
  dialect: Dialect;
  store: SampleStore;
}

export interface Simulator {
  fetch: FetchImpl;
}

export function createSimulator(opts: SimulatorOptions): Simulator {
  void opts;
  throw new Error('not implemented');
}

export interface SampleAwareFetchOptions {
  sampleSwitch: SampleSwitch;
  simulator: Pick<Simulator, 'fetch'>;
  network: FetchImpl;
}

/** A FetchImpl for fetchWithBudget's `fetchImpl` option. */
export function sampleAwareFetch(opts: SampleAwareFetchOptions): FetchImpl {
  void opts;
  throw new Error('not implemented');
}

export type SampleHook<Env> = (args: unknown, env: Env) => Promise<{ ok: true }>;

/** on_sample_load: sets the flag. Rejects on a failed write, so the platform sees failure. */
export function sampleLoadHook<Env>(storeFor: (env: Env) => SampleStore): SampleHook<Env> {
  void storeFor;
  throw new Error('not implemented');
}

/** on_sample_remove: deletes the flag and the overlay in one statement. Rejects on failure. */
export function sampleRemoveHook<Env>(storeFor: (env: Env) => SampleStore): SampleHook<Env> {
  void storeFor;
  throw new Error('not implemented');
}

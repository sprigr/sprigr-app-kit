/**
 * mock-warehouse - what the handlers depend on, resolved from env.
 *
 * On the platform `env.DB` is always bound, so handlers run against the
 * per-install D1 table. With no DB the app falls back to a module-level
 * in-memory store, which is how the conformance harness and the unit tests
 * drive the shipped handler map directly. The fallback is unreachable in
 * production: the marketplace runtime binds D1 before the first dispatch.
 */

import { d1Store, memoryStore, type WarehouseStore } from './store';
import { createVendor, type MockVendor } from './vendor';
import type { MockWarehouseEnv } from './env';

export interface WarehouseDeps {
  store: WarehouseStore;
  vendor: MockVendor;
  now(): string;
}

let fallback: WarehouseDeps | undefined;
/** One D1-backed vendor per isolate: the call count is telemetry, not state. */
let d1Vendor: MockVendor | undefined;

export function depsFor(env: MockWarehouseEnv): WarehouseDeps {
  if (env.DB) {
    d1Vendor ??= createVendor();
    return { store: d1Store(env.DB), vendor: d1Vendor, now: () => new Date().toISOString() };
  }
  fallback ??= { store: memoryStore(), vendor: createVendor(), now: () => new Date().toISOString() };
  return fallback;
}

/** Test helper: a self-contained deps bundle with its own store and vendor. */
export function freshDeps(now: () => string = () => new Date().toISOString()): WarehouseDeps {
  return { store: memoryStore(), vendor: createVendor(), now };
}

/**
 * mock-order-source - what the handlers depend on, resolved from env.
 *
 * With `env.DB` bound (always, on the platform) the handlers run against the
 * per-install D1 tables. Without it they fall back to a module-level
 * in-memory store carrying the same seed, which is how the conformance
 * harness and the unit tests drive the shipped handler map. The fallback is
 * unreachable in production: the runtime binds D1 before the first dispatch.
 */

import { d1Store, memoryStore, type OrderSourceStore } from './store';
import type { MockOrderSourceEnv } from './env';

export interface OrderSourceDeps {
  store: OrderSourceStore;
  now(): string;
}

let fallback: OrderSourceDeps | undefined;

export function depsFor(env: MockOrderSourceEnv): OrderSourceDeps {
  if (env.DB) return { store: d1Store(env.DB), now: () => new Date().toISOString() };
  fallback ??= { store: memoryStore(), now: () => new Date().toISOString() };
  return fallback;
}

/** Test helper: a self-contained deps bundle with its own seeded store. */
export function freshDeps(now: () => string = () => new Date().toISOString()): OrderSourceDeps {
  return { store: memoryStore(), now };
}

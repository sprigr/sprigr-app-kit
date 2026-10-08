/**
 * Vitest setup: every fetch an app-sdk test installs refuses what Workers
 * refuses (see tests/helpers/workers-fetch.ts). Covers both ways the suite
 * stubs fetch: `vi.stubGlobal('fetch', fn)` and `globalThis.fetch = fn`.
 */
import { vi } from 'vitest';
import { workersFaithful } from '../helpers/workers-fetch';

let current = workersFaithful(globalThis.fetch);
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get: () => current,
  set: (fn: typeof globalThis.fetch) => {
    current = workersFaithful(fn);
  },
});

const stubGlobal = vi.stubGlobal.bind(vi);
vi.stubGlobal = ((name: string | symbol | number, value: unknown) =>
  stubGlobal(name, name === 'fetch' ? workersFaithful(value) : value)) as typeof vi.stubGlobal;

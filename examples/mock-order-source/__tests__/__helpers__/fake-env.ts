/**
 * A fake env for the mock-order-source handler map.
 *
 * No `DB`, so `depsFor` hands the handlers the in-memory store carrying the
 * same seed migration 0001 writes; `recorded` captures every event the app
 * would have emitted. Nothing here stands in for a handler.
 */

import { depsFor } from '../../src/lib/deps';
import type { MockOrderSourceEnv } from '../../src/lib/env';

export interface FakeEnv extends MockOrderSourceEnv {
  recorded: Array<{ event: string; payload: Record<string, unknown> }>;
}

export function fakeEnv(): FakeEnv {
  const recorded: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    recorded,
    SPRIGR: {
      async emit(event, payload) {
        recorded.push({ event, payload });
        return { ok: true };
      },
      async log() {
        return { ok: true };
      },
    },
  };
}

export function envDeps(env: MockOrderSourceEnv) {
  return depsFor(env);
}

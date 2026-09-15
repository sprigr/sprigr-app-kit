/**
 * A fake env for the mock-warehouse handler map.
 *
 * No `DB`, so `depsFor` hands the handlers their in-memory store and the
 * call-counting vendor; `recorded` captures every event the app would have
 * emitted. Nothing here stands in for a handler: the tests drive the exact
 * map the marketplace runtime dispatches.
 */

import { depsFor } from '../../src/lib/deps';
import type { MockWarehouseEnv } from '../../src/lib/env';

export interface FakeEnv extends MockWarehouseEnv {
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

/** The deps bundle the handlers will resolve for a DB-less env. */
export function envDeps(env: MockWarehouseEnv) {
  return depsFor(env);
}

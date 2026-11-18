import type { SampleStore } from './types';

/** An app lifecycle hook. A rejection is how the platform sees failure, so these never swallow one. */
export type SampleHook<Env> = (args: unknown, env: Env) => Promise<{ ok: true }>;

/** on_sample_load: sets the flag. Writes already in the overlay are kept. */
export function sampleLoadHook<Env>(storeFor: (env: Env) => SampleStore): SampleHook<Env> {
  return async (_args, env) => {
    await storeFor(env).setOn();
    return { ok: true };
  };
}

/**
 * on_sample_remove: deletes the flag and the overlay in one statement. A failed
 * delete rejects, so the platform keeps sample mode on for the workspace.
 */
export function sampleRemoveHook<Env>(storeFor: (env: Env) => SampleStore): SampleHook<Env> {
  return async (_args, env) => {
    await storeFor(env).clear();
    return { ok: true };
  };
}

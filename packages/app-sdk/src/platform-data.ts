/**
 * `env.SPRIGR.data.partialUpdate` from BOTH execution contexts.
 *
 * The platform exposes `env.SPRIGR.data.partialUpdate(objects, opts)` on
 * every `/__sprigr/*` dispatch path, backed by
 * `POST /internal/wfp/data/partial-update` on the provisioning worker. It
 * merges fields into objects the app already imported without the app
 * reading them first, which is what turns a read-then-`import` round trip
 * (two platform calls, a race window, and a whole-object rewrite) into one
 * call that touches only the fields named.
 *
 * Merge semantics, identical on both transports because the platform does
 * the merge: nested objects recurse, arrays and scalars replace wholesale,
 * keys the patch does not carry survive, and `null` is a value that
 * overwrites. `createIfNotExists` defaults to `false` so a patch never
 * creates half an object unless asked. On a hash- or date-sharded logical
 * index every patch MUST carry the `shard_field` value or the whole batch
 * fails with `shard_field_invalid`: a patch cannot be routed to its shard
 * otherwise. The per-call cap is the same 1000 objects as `import`.
 *
 * This module carries two things:
 *
 *   1. `buildPartialUpdateBody`, the wire body both transports send, with
 *      the client-side checks that reject a batch BEFORE anything is sent
 *      (too many objects, a patch without a string `objectID`).
 *   2. The inline-route fallback (`partialUpdateData`, `canPartialUpdate`).
 *      Inline Next.js route handlers never receive `env.SPRIGR`, so an app
 *      whose provider webhook lands on one has no `data` namespace there.
 *      Same escape hatch as `emitMarketplaceEvent` and `logToPlatform`:
 *      `POST ${SPRIGR_PLATFORM_BASE}/internal/wfp/data/partial-update`
 *      with the `SPRIGR_INSTALL_TOKEN` bearer.
 *
 * Unlike `emit` and `log`, this THROWS on failure, matching the host
 * member and `data.import`: a data write the caller wants the result of
 * must not be reported as a soft `{ ok: false }` a webhook ack path could
 * swallow.
 *
 * Wire contract (workers/provisioning/src/wfp-data.ts in sprigr-team):
 *   POST { index?, objects, createIfNotExists? }
 *   200 { ok: true, updated, skippedMissing, index, physical_indexes? }
 *   400 { error, detail, index? } with error one of too_many_objects,
 *       invalid_object, unknown_data_index, shard_field_invalid, ...
 *   401 / 404 bad token / inactive install
 */

import { installTokenPost, resolveInstallBridge, type WfpBridgeEnv } from './wfp-bridge';
import type { SprigrDataPartialUpdateOpts, SprigrDataPartialUpdateResult } from './index';

/** Route the host member and the fallback both call. */
export const DATA_PARTIAL_UPDATE_PATH = '/internal/wfp/data/partial-update';

/** Same per-call cap as `data.import` (`MAX_OBJECTS_PER_CALL` in wfp-data.ts). */
export const SPRIGR_DATA_MAX_OBJECTS_PER_CALL = 1000;

/** One patch: the target `objectID` plus only the fields to merge. */
export type SprigrDataPatch = { objectID: string; [key: string]: unknown };

/** The body `POST /internal/wfp/data/partial-update` receives. */
export interface SprigrDataPartialUpdateBody {
  index?: string;
  objects: SprigrDataPatch[];
  createIfNotExists: boolean;
}

export interface PartialUpdateDataOptions extends SprigrDataPartialUpdateOpts {
  /** Ceiling on the HTTP fallback. No default: a data write is awaited for its result. */
  timeoutMs?: number;
}

type PartialUpdateFn = (
  objects: SprigrDataPatch[],
  opts?: SprigrDataPartialUpdateOpts,
) => Promise<SprigrDataPartialUpdateResult>;

/**
 * Thrown by `buildPartialUpdateBody` (and therefore by `partialUpdateData`)
 * before anything is sent. `error` is the same code the platform would
 * answer with, so a caller can branch on one vocabulary.
 */
export class SprigrDataValidationError extends Error {
  readonly error: string;
  readonly index?: number;

  constructor(message: string, fields: { error: string; index?: number }) {
    super(message);
    this.name = 'SprigrDataValidationError';
    this.error = fields.error;
    if (fields.index !== undefined) this.index = fields.index;
  }
}

/**
 * Build the wire body, rejecting what the platform would reject anyway so
 * the failure is at the call site rather than a 400 in a tail log. Pure.
 * `createIfNotExists` is always explicit in the output so the default is
 * visible on the wire and in tests, never inferred server-side.
 */
export function buildPartialUpdateBody(
  objects: unknown,
  opts?: SprigrDataPartialUpdateOpts,
): SprigrDataPartialUpdateBody {
  const at = 'env.SPRIGR.data.partialUpdate';
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new SprigrDataValidationError(`${at}: objects must be a non-empty array`, {
      error: 'invalid_object',
    });
  }
  if (objects.length > SPRIGR_DATA_MAX_OBJECTS_PER_CALL) {
    throw new SprigrDataValidationError(
      `${at}: at most ${SPRIGR_DATA_MAX_OBJECTS_PER_CALL} objects per call (got ${objects.length}); nothing was sent. Split the batch.`,
      { error: 'too_many_objects' },
    );
  }
  for (let i = 0; i < objects.length; i++) {
    const o: unknown = objects[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      throw new SprigrDataValidationError(`${at}: objects[${i}] must be an object`, {
        error: 'invalid_object',
        index: i,
      });
    }
    const id = (o as { objectID?: unknown }).objectID;
    if (typeof id !== 'string' || id.length === 0) {
      throw new SprigrDataValidationError(
        `${at}: objects[${i}].objectID must be a non-empty string (a patch has to name its target)`,
        { error: 'invalid_object', index: i },
      );
    }
  }
  if (opts?.index !== undefined && (typeof opts.index !== 'string' || opts.index.length === 0)) {
    throw new SprigrDataValidationError(`${at}: index must be a non-empty string when given`, {
      error: 'unknown_data_index',
    });
  }
  return {
    ...(opts?.index !== undefined ? { index: opts.index } : {}),
    objects: objects as SprigrDataPatch[],
    createIfNotExists: opts?.createIfNotExists === true,
  };
}

/** Narrow an unknown `env.SPRIGR` down to a callable `data.partialUpdate`. */
function bindingPartialUpdate(env: WfpBridgeEnv): PartialUpdateFn | null {
  const data = (env.SPRIGR as { data?: { partialUpdate?: unknown } } | undefined)?.data;
  return typeof data?.partialUpdate === 'function'
    ? (data.partialUpdate as PartialUpdateFn).bind(data)
    : null;
}

/**
 * Whether a partial update could reach the platform at all, by either
 * transport. Gate a "patch the mirror" step on this rather than on
 * `env.SPRIGR?.data?.partialUpdate`, which is absent on every inline route
 * and on wrapper builds older than the platform route.
 */
export function canPartialUpdate(env: WfpBridgeEnv): boolean {
  return bindingPartialUpdate(env) !== null || resolveInstallBridge(env) !== null;
}

function describeMissingDataPath(env: WfpBridgeEnv): string {
  const base = typeof env.SPRIGR_PLATFORM_BASE === 'string' && env.SPRIGR_PLATFORM_BASE ? 'set' : 'unset';
  const token = typeof env.SPRIGR_INSTALL_TOKEN === 'string' && env.SPRIGR_INSTALL_TOKEN ? 'set' : 'unset';
  return `no_data_path (SPRIGR.data.partialUpdate absent, SPRIGR_PLATFORM_BASE=${base}, SPRIGR_INSTALL_TOKEN=${token})`;
}

/**
 * Merge fields into stored objects from any execution context.
 *
 * Prefers the injected `env.SPRIGR.data.partialUpdate`; falls back to the
 * install-token bridge when it is absent (an inline Next route, or a
 * wrapper build that predates the member). Validation runs first and
 * THROWS `SprigrDataValidationError` on a bad batch, before anything is
 * sent. A platform rejection also throws: the `Error` from
 * `installTokenPost` carries `.status`, `.error` (the platform's code, e.g.
 * `shard_field_invalid`) and `.detail`. Nothing here is swallowed.
 *
 *   // before: two calls and a whole-object rewrite
 *   const { object } = await env.SPRIGR.data.get(orderId, { index: 'orders' });
 *   await env.SPRIGR.data.import([{ ...object, status: 'shipped' }], { index: 'orders' });
 *
 *   // after: one call, only the named field changes
 *   await partialUpdateData(env, [{ objectID: orderId, created_at, status: 'shipped' }], { index: 'orders' });
 *
 * (`created_at` rides along because `orders` is date-sharded on it; an
 * unsharded index needs only `objectID` and the fields to change.)
 */
export async function partialUpdateData(
  env: WfpBridgeEnv,
  objects: SprigrDataPatch[],
  opts?: PartialUpdateDataOptions,
): Promise<SprigrDataPartialUpdateResult> {
  const { timeoutMs, ...dataOpts } = opts ?? {};
  const body = buildPartialUpdateBody(objects, dataOpts);

  const injected = bindingPartialUpdate(env);
  if (injected) {
    // Hand the member the explicit default too, so both transports carry
    // `createIfNotExists: false` rather than leaving one to infer it.
    return injected(body.objects, {
      ...(body.index !== undefined ? { index: body.index } : {}),
      createIfNotExists: body.createIfNotExists,
    });
  }

  const bridge = resolveInstallBridge(env);
  if (!bridge) {
    throw new Error(`env.SPRIGR.data.partialUpdate unavailable: ${describeMissingDataPath(env)}`);
  }
  return (await installTokenPost(bridge, DATA_PARTIAL_UPDATE_PATH, body, {
    label: 'data.partialUpdate',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })) as unknown as SprigrDataPartialUpdateResult;
}

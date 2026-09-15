/**
 * The per-op checks both suites share: the handler exists and does not
 * throw, it answers inside the budget, its output matches the contract
 * shape, and a write op acknowledges with one of the three async statuses.
 */

import { ACK_STATUSES_NEEDING_REASON, toolNameFor, type OpSpec } from './contract';
import { invokeOp } from './invoke';
import type { CheckCollector } from './report';
import { checkShape, isPlainObject } from './shape';
import type { AdapterHandlers } from './types';

export interface DriveContext {
  handlers: AdapterHandlers;
  env: unknown;
  slug: string;
  budgetMs: number;
  fixtures: Record<string, Record<string, unknown>>;
  checks: CheckCollector;
}

/**
 * Run one op and record its checks. Returns the output object when the call
 * produced one, so a suite can chain an id from it into the next op.
 */
export async function driveOp(
  ctx: DriveContext,
  spec: OpSpec,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const toolName = toolNameFor(ctx.slug, spec.name);
  const merged = { ...args, ...(ctx.fixtures[spec.name] ?? {}) };
  const call = await invokeOp(ctx.handlers, toolName, merged, ctx.env, ctx.budgetMs);

  if (call.timedOut) {
    ctx.checks.fail(
      `${spec.name}.within_budget`,
      `${toolName} did not return within ${ctx.budgetMs}ms. Every op that reaches a third party must acknowledge inside the dispatch budget and deliver its outcome as an event.`,
    );
    return undefined;
  }
  if (call.error !== undefined) {
    ctx.checks.fail(`${spec.name}.invoked`, `${toolName} failed: ${call.error}`);
    return undefined;
  }
  ctx.checks.pass(`${spec.name}.invoked`, `${toolName} returned in ${call.ms}ms`);
  ctx.checks.pass(`${spec.name}.within_budget`, `${call.ms}ms of a ${ctx.budgetMs}ms budget`);

  const issues = checkShape(call.value, spec.output, spec.name);
  ctx.checks.issues(`${spec.name}.output_shape`, issues, 'matches the contract output shape');

  if (spec.ack) {
    const out = isPlainObject(call.value) ? call.value : {};
    const status = out.status;
    const isAck = typeof status === 'string' && spec.ackStatuses.includes(status);
    ctx.checks.add(
      `${spec.name}.ack_status`,
      isAck,
      isAck
        ? `acknowledged with "${String(status)}"`
        : `a write op on this interface must acknowledge with ${spec.ackStatuses.join(' | ')}; got ${JSON.stringify(status)}. The two interfaces do not share one enum, and a synchronous success/failure value means the op blocks on the vendor.`,
    );
    if (typeof status === 'string' && (ACK_STATUSES_NEEDING_REASON as readonly string[]).includes(status)) {
      const reason = out.reason;
      ctx.checks.add(
        `${spec.name}.${status}_has_reason`,
        typeof reason === 'string' && reason.length > 0,
        typeof reason === 'string' && reason.length > 0
          ? `refusal explained: ${reason}`
          : `a "${status}" ack must carry a non-empty reason; the hub has no other way to tell a refusal from a bug`,
      );
    } else if (spec.ackRefField) {
      const ref = out[spec.ackRefField];
      ctx.checks.add(
        `${spec.name}.${spec.ackRefField}_on_ack`,
        typeof ref === 'string' && ref.length > 0,
        typeof ref === 'string' && ref.length > 0
          ? `${spec.ackRefField}=${ref}`
          : `a "${String(status)}" ack must carry a non-empty ${spec.ackRefField}; the hub correlates the later event on it`,
      );
    }
  }

  return isPlainObject(call.value) ? call.value : undefined;
}

/** Look up an op spec by name, throwing on a typo in the suite itself. */
export function opByName(ops: readonly OpSpec[], name: string): OpSpec {
  const spec = ops.find((o) => o.name === name);
  if (!spec) throw new Error(`fulfilment-conformance: no op named "${name}" in the contract`);
  return spec;
}

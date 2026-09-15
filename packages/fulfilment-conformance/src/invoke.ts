/**
 * Timed, budget-bounded invocation of one adapter op.
 *
 * The budget is raced rather than measured after the fact: an op that never
 * settles would otherwise hang the suite instead of reporting the failure it
 * is there to catch.
 */

import type { AdapterHandlers } from './types';

export interface OpInvocation {
  toolName: string;
  ms: number;
  timedOut: boolean;
  /** Set when the handler returned or threw. */
  value?: unknown;
  error?: string;
}

export async function invokeOp(
  handlers: AdapterHandlers,
  toolName: string,
  args: Record<string, unknown>,
  env: unknown,
  budgetMs: number,
): Promise<OpInvocation> {
  const handler = handlers[toolName];
  const started = Date.now();
  if (typeof handler !== 'function') {
    return {
      toolName,
      ms: 0,
      timedOut: false,
      error: `no handler named "${toolName}" in the handler map (keys: ${Object.keys(handlers).join(', ') || 'none'})`,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'__budget__'>((resolve) => {
    timer = setTimeout(() => resolve('__budget__'), budgetMs);
  });
  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(() => (handler as (a: unknown, e: unknown) => unknown)(args, env))
        .then(
          (value) => ({ value }),
          (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
        ),
      timeout,
    ]);
    const ms = Date.now() - started;
    if (raced === '__budget__') return { toolName, ms, timedOut: true };
    if ('error' in raced) return { toolName, ms, timedOut: false, error: raced.error };
    return { toolName, ms, timedOut: false, value: raced.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shared types for the two conformance suites. */

/**
 * An adapter's handler map: the default export of a handler file, exactly as
 * the marketplace runtime dispatches it. `env` is whatever the adapter's own
 * env type is; the harness only passes through what `opts.env()` returned.
 */
export type AdapterHandler = (args: never, env: never) => unknown;
export type AdapterHandlers = Record<string, (args: never, env: never) => unknown>;

export interface ConformanceOptions {
  /** Adapter slug as it appears in `metadata.slug`, e.g. `mock-warehouse`. */
  slug: string;
  /**
   * Fake env factory. Called ONCE per suite run, and the same env is passed
   * to every op: `push_order` idempotency is a stateful property, so a fresh
   * env per call would make it untestable.
   */
  env: () => unknown;
  /**
   * Number of calls the adapter has made to its fake vendor so far. The
   * harness reads it before and after each `push_order` to prove the repeat
   * call was served from the idempotency record rather than the warehouse.
   * Required for the fulfilment_provider suite.
   */
  vendorCalls?: () => number;
  /** Per-op wall-clock budget in ms. Default 20000 (the 25 s dispatch budget, minus headroom). */
  timeBudgetMs?: number;
  /**
   * Per-op input overrides, merged over the harness fixtures. Supply the ids
   * the adapter's own store knows about (`get_order`'s `source_ref`,
   * `accept_request`'s `source_request_ref`) so the harness exercises the
   * found path rather than the miss path.
   */
  fixtures?: Record<string, Record<string, unknown>>;
}

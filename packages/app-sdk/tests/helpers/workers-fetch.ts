/**
 * Make a mocked fetch refuse what the Cloudflare Workers runtime refuses.
 *
 * Every app runs on Workers, but these tests run on Node, whose fetch accepts
 * options Workers throws on. A mocked fetch that ignores its init lets such a
 * call pass in tests and fail on every request in production: app-sdk 0.21.0
 * shipped `redirect: 'error'` in readFileRef / openFileRef that way
 * (sprigr/sprigr-team#10981).
 *
 * `tests/setup/workers-fetch.ts` wraps every fetch a test installs (through
 * `vi.stubGlobal('fetch', ...)` or `globalThis.fetch = ...`) with this check,
 * so no app-sdk test needs to opt in. Add a refusal here only with the
 * runtime's own error text.
 */

/** The error Workers throws for `redirect: 'error'`, verbatim from a live staging send. */
export const WORKERS_REDIRECT_ERROR =
  'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code)';

const WORKERS_REDIRECT_VALUES = new Set(['follow', 'manual']);

/** Throws the TypeError Workers would throw for this fetch call, or returns. */
export function assertWorkersFetchInit(input: unknown, init?: RequestInit): void {
  const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
  if (redirect !== undefined && !WORKERS_REDIRECT_VALUES.has(redirect)) {
    throw new TypeError(WORKERS_REDIRECT_ERROR);
  }
}

const WRAPPED = Symbol.for('app-sdk.tests.workersFaithfulFetch');

/** Wrap a fetch (mock or real) so it refuses Workers-invalid options first. Idempotent. */
export function workersFaithful<T>(fetchImpl: T): T {
  if (typeof fetchImpl !== 'function' || (fetchImpl as { [WRAPPED]?: true })[WRAPPED]) return fetchImpl;
  const inner = fetchImpl as unknown as (input: unknown, init?: RequestInit) => unknown;
  const wrapped = function (this: unknown, input: unknown, init?: RequestInit) {
    try {
      assertWorkersFetchInit(input, init);
    } catch (err) {
      return Promise.reject(err);
    }
    return inner.call(this, input, init);
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped as unknown as T;
}

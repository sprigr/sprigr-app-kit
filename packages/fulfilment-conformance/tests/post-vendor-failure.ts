/**
 * The failure sprigr/sprigr-app-kit#78 is about: the warehouse took the
 * order, then the adapter's own record write failed (a D1 error, a cut-off
 * invocation), so the hub's retry arrives with nothing recorded.
 *
 * Wraps an adapter's request store so the FIRST write made after the vendor
 * has been called once throws. Reads pass through untouched. Shape-agnostic on
 * purpose: a read-then-push adapter fails its after-the-vendor insert, a
 * claim-first one fails its after-the-vendor update, and the test asserts the
 * retry makes no second vendor call either way.
 */
export const POST_VENDOR_WRITE_FAILURE = 'simulated D1 failure on the record write after the warehouse call';

export function failFirstWriteAfterVendor<T extends object>(store: T, vendorCalls: () => number): T {
  let failed = false;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || prop === 'get') return value;
      return async (...args: unknown[]) => {
        if (!failed && vendorCalls() > 0) {
          failed = true;
          throw new Error(POST_VENDOR_WRITE_FAILURE);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

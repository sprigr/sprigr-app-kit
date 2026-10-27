/**
 * push_order must not reach the warehouse twice for one fulfilment_request_id,
 * including when the first attempt's record write failed after the warehouse
 * had already taken the order (sprigr/sprigr-app-kit#78). The conformance
 * suite covers two deliveries at once; this covers the retry after the crash.
 */
import { describe, expect, it } from 'vitest';
import {
  POST_VENDOR_WRITE_FAILURE,
  failFirstWriteAfterVendor,
} from '../../../packages/fulfilment-conformance/tests/post-vendor-failure';
import { pushOrder } from '../src/handlers/provider';
import { freshDeps } from '../src/lib/deps';

const ARGS = {
  fulfilment_request_id: 'fr_crash',
  order_id: 'ord_crash',
  warehouse_key: 'mw_bne',
  lines: [{ line_id: 'ln_1', sku: 'MW-1', quantity: 1 }],
};

describe('push_order after a failed record write', () => {
  it('the retry answers queued and makes no second warehouse call', async () => {
    const deps = freshDeps();
    const crashing = { ...deps, store: failFirstWriteAfterVendor(deps.store, () => deps.vendor.calls) };

    await expect(pushOrder(crashing, ARGS)).rejects.toThrow(POST_VENDOR_WRITE_FAILURE);
    expect(deps.vendor.calls).toBe(1);

    const retry = await pushOrder(crashing, ARGS);
    expect(deps.vendor.calls, 'the retry pushed the order to the warehouse a second time').toBe(1);
    expect(retry.status).toBe('queued');
  });
});

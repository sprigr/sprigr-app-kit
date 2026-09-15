/**
 * mock-warehouse - the stand-in warehouse API.
 *
 * A real adapter calls a 3PL here. The mock mints a deterministic
 * `provider_ref` from the hub's `fulfilment_request_id`, so a shakedown can
 * predict every id it will see, and counts its calls so the conformance
 * harness can prove a repeat `push_order` never reached it.
 */

export interface VendorCreateOrderInput {
  fulfilment_request_id: string;
  warehouse_key: string;
  line_count: number;
}

export interface MockVendor {
  createOrder(input: VendorCreateOrderInput): Promise<{ provider_ref: string }>;
  /** Calls made since this vendor was created. The harness reads it. */
  readonly calls: number;
}

export function createVendor(): MockVendor {
  let calls = 0;
  return {
    async createOrder(input) {
      calls += 1;
      return { provider_ref: `mw_${input.fulfilment_request_id}` };
    },
    get calls() {
      return calls;
    },
  };
}

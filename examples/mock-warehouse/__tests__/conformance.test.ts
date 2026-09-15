/**
 * The whole fulfilment-hub/fulfilment_provider contract, run against this
 * app's real handler map.
 *
 * The harness is imported from the kit's own source by relative path because
 * `@sprigr/apps-fulfilment-conformance` is not published yet. An adapter
 * living in sprigr-apps declares it as an exact-pinned devDependency and
 * imports `@sprigr/apps-fulfilment-conformance/vitest` instead; that is what
 * `pnpm create:app <slug> --template fulfilment-provider` generates.
 */
import { describeConformance } from '../../../packages/fulfilment-conformance/src/vitest';
import handlers from '../src/handlers/provider';
import manifest from '../sprigr-app.json';
import { fakeEnv, envDeps } from './__helpers__/fake-env';

const env = fakeEnv();
const deps = envDeps(env);

describeConformance({
  role: 'fulfilment_provider',
  slug: 'mock-warehouse',
  handlers,
  manifest,
  env: () => env,
  // The mock's stand-in warehouse API counts its own calls, which is what
  // proves the repeat push_order was served from the idempotency record.
  vendorCalls: () => deps.vendor.calls,
  fixtures: {
    // The harness's default key is not one of this app's warehouses, and a
    // rejected push would make the idempotency checks meaningless.
    push_order: { warehouse_key: 'mw_bne' },
    get_stock: { warehouse_key: 'mw_bne', skus: ['CONF-SKU-1', 'CONF-SKU-2'] },
  },
});

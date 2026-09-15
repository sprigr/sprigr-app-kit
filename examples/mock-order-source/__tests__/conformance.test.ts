/**
 * The whole fulfilment-hub/order_source contract, run against this app's
 * real handler map.
 *
 * The harness is imported from the kit's own source by relative path because
 * `@sprigr/apps-fulfilment-conformance` is not published yet. An adapter
 * living in sprigr-apps declares it as an exact-pinned devDependency and
 * imports `@sprigr/apps-fulfilment-conformance/vitest` instead; that is what
 * `pnpm create:app <slug> --template order-source` generates.
 */
import { describeConformance } from '../../../packages/fulfilment-conformance/src/vitest';
import handlers from '../src/handlers/order-source';
import manifest from '../sprigr-app.json';
import { SEED_ORDER, SEED_REQUEST } from '../src/lib/records';
import { fakeEnv } from './__helpers__/fake-env';

const env = fakeEnv();

describeConformance({
  role: 'order_source',
  slug: 'mock-order-source',
  handlers,
  manifest,
  env: () => env,
  // The seed migration writes these, so every op the harness drives lands on
  // a real row instead of exercising the miss path.
  fixtures: {
    get_order: { source_ref: SEED_ORDER.source_ref },
    accept_request: { source_request_ref: SEED_REQUEST.source_request_ref },
    reject_request: { source_request_ref: SEED_REQUEST.source_request_ref },
    hold: { source_request_ref: SEED_REQUEST.source_request_ref },
    release: { source_request_ref: SEED_REQUEST.source_request_ref },
    cancel: { source_request_ref: SEED_REQUEST.source_request_ref },
    split: { source_request_ref: SEED_REQUEST.source_request_ref },
    mark_shipped: { source_request_ref: SEED_REQUEST.source_request_ref, source_ref: SEED_ORDER.source_ref },
    add_note: { source_ref: SEED_ORDER.source_ref },
  },
});

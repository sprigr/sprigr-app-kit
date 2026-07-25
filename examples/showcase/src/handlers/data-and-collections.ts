/**
 * Showcase - env.SPRIGR.data.* + env.SPRIGR.collections.* + fulfillment
 * services reference module.
 *
 *   data.import   upsert objects into the app's per-company data index
 *                 (each needs a string objectID; 1000/call cap). Faceting is
 *                 driven by the manifest data_index config.
 *   data.search   full-text / semantic / faceted query over that index.
 *   data.get      point read by objectID.
 *
 *   collections.* a higher-level, versioned, keyed dataset with change
 *                 history + reconcile. Requires the sprigr.collections scope.
 *
 *   fulfillment_services.register  register a Shopify fulfilment location per
 *                 warehouse (requires brand consent — err.code='no_consent'
 *                 otherwise). Declared in manifest fulfillment_services[].
 *
 * All staging-only.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';

// ── data index ───────────────────────────────────────────────────────────────
export async function cacheContacts(
  env: ShowcaseEnv,
  contacts: Array<{ id: string; name: string; email: string; company: string; stage: string; owner: string; source: string }>,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.data.import(contacts.map((c) => ({ objectID: c.id, ...c }))),
    'cacheContacts calls env.SPRIGR.data.import — publish to staging.',
  );
}

export async function searchContacts(env: ShowcaseEnv, query: string, stage?: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.data.search({
        query,
        semantic: true,
        hitsPerPage: 20,
        facets: ['stage', 'owner', 'source'],
        ...(stage ? { filters: `stage:${stage}` } : {}),
      }),
    'searchContacts calls env.SPRIGR.data.search — publish to staging.',
  );
}

export async function getContact(env: ShowcaseEnv, contactId: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.data.get(contactId),
    'getContact calls env.SPRIGR.data.get — publish to staging.',
  );
}

// ── collections (keyed, versioned, reconcilable) ─────────────────────────────
export async function defineDealsCollection(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.collections.define({
        scope: 'company',
        name_suffix: 'acme-deals',
        description: 'Acme CRM deals, keyed by deal id, with change history.',
        key: { strategy: 'composite', fields: ['deal_id'] },
        fields: [
          { name: 'deal_id', type: 'string', facet: false },
          { name: 'stage', type: 'string', facet: true },
          { name: 'amount', type: 'number', facet: false },
        ],
        searchable: ['deal_id', 'stage'],
        history: true,
      }),
    'defineDealsCollection calls env.SPRIGR.collections.define — publish to staging.',
  );
}

export async function ingestDeals(
  env: ShowcaseEnv,
  rows: Array<{ deal_id: string; stage: string; amount: number }>,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.collections.ingest({ scope: 'company', name_suffix: 'acme-deals', rows }),
    'ingestDeals calls env.SPRIGR.collections.ingest — publish to staging.',
  );
}

export async function ingestDealsFromTable(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.collections.ingestFromTable({
        scope: 'company',
        name_suffix: 'acme-deals',
        table: 'showcase_settings',
        column_map: { deal_id: 'key', stage: 'value' },
      }),
    'ingestDealsFromTable calls env.SPRIGR.collections.ingestFromTable — publish to staging.',
  );
}

export async function queryDeals(env: ShowcaseEnv, stage: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.collections.query({ scope: 'company', name_suffix: 'acme-deals', filters: `stage:${stage}` }),
    'queryDeals calls env.SPRIGR.collections.query — publish to staging.',
  );
}

export async function reconcileDeals(
  env: ShowcaseEnv,
  liveKeys: string[],
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.collections.reconcile({ scope: 'company', name_suffix: 'acme-deals', present_keys: liveKeys }),
    'reconcileDeals calls env.SPRIGR.collections.reconcile (marks absent keys deleted) — publish to staging.',
  );
}

export async function describeDeals(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.collections.describe({ scope: 'company', name_suffix: 'acme-deals' }),
    'describeDeals calls env.SPRIGR.collections.describe — publish to staging.',
  );
}

export async function dealHistory(env: ShowcaseEnv, dealId: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.collections.history({ scope: 'company', name_suffix: 'acme-deals', key: dealId }),
    'dealHistory calls env.SPRIGR.collections.history — publish to staging.',
  );
}

// ── fulfillment services (Shopify FO) ────────────────────────────────────────
export async function registerWarehouse(
  env: ShowcaseEnv,
  integrationId: string,
  warehouse: { key: string; name: string },
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.fulfillment_services.register({
        platform: 'shopify',
        integrationId,
        serviceKey: warehouse.key,
        serviceName: warehouse.name,
        inventoryManagement: true,
        trackingSupport: true,
        requiresShippingMethod: false,
      }),
    'registerWarehouse calls env.SPRIGR.fulfillment_services.register (requires brand consent) — publish to staging.',
  );
}

export async function listWarehouses(env: ShowcaseEnv, integrationId: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.fulfillment_services.list({ platform: 'shopify', integrationId }),
    'listWarehouses calls env.SPRIGR.fulfillment_services.list — publish to staging.',
  );
}

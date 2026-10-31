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
 *                 history + reconcile. No manifest scope: the platform
 *                 authenticates the install token and keeps every call in the
 *                 install's own company (sprigr-team
 *                 workers/provisioning/src/wfp-collections.ts). Only define
 *                 takes scope + name_suffix; it returns the full index name,
 *                 and every other op takes that name as `collection`.
 *
 *   fulfillment_services.register  register a Shopify fulfilment location per
 *                 warehouse (requires brand consent — err.code='no_consent'
 *                 otherwise). Declared in manifest fulfillment_services[].
 *
 * All staging-only.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';
import { getSetting, setSetting } from '../lib/store';
import type { CollectionDefinition } from '../lib/sprigr-host';

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
type Deal = { deal_id: string; stage: string; amount: number };

const DEALS_COLLECTION_SETTING = 'deals_collection';

/** The define body. define is idempotent: re-calling it unchanged is a cheap no-op. */
const DEALS_DEFINITION: CollectionDefinition = {
  scope: 'company',
  name_suffix: 'acme-deals',
  description: 'Acme CRM deals, keyed by deal id, with change history.',
  // natural = one key field; composite = several. Either derives the
  // record's objectID from the key, so re-ingesting a deal updates it.
  key: { strategy: 'natural', fields: ['deal_id'] },
  fields: [
    { name: 'deal_id', type: 'string', facet: false },
    { name: 'stage', type: 'string', facet: true },
    { name: 'amount', type: 'number', facet: false },
  ],
  searchable: ['deal_id', 'stage'],
  history: true,
};

/**
 * The collection's full index name, which define returns and every other op
 * takes as `collection`. Cached in showcase_settings so only the first call
 * pays for the define round trip.
 */
async function dealsCollection(env: ShowcaseEnv): Promise<string> {
  const cached = await getSetting(env.DB, DEALS_COLLECTION_SETTING);
  if (cached) return cached;
  const { collection } = await env.SPRIGR.collections.define(DEALS_DEFINITION);
  await setSetting(env.DB, DEALS_COLLECTION_SETTING, collection);
  return collection;
}

export async function defineDealsCollection(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(async () => {
    const res = await env.SPRIGR.collections.define(DEALS_DEFINITION);
    await setSetting(env.DB, DEALS_COLLECTION_SETTING, res.collection);
    return res;
  }, 'defineDealsCollection calls env.SPRIGR.collections.define — publish to staging.');
}

/** Upsert deals by the declared key. At most 1000 records per call: chunk larger batches. */
export async function ingestDeals(env: ShowcaseEnv, deals: Deal[]): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () => env.SPRIGR.collections.ingest({ collection: await dealsCollection(env), records: deals }),
    'ingestDeals calls env.SPRIGR.collections.ingest — publish to staging.',
  );
}

/**
 * Ingest rows you already parsed (an Acme CSV export, keyed by column
 * header). `mapping` runs source column -> collection field; columns it
 * does not name are dropped. The platform reads nothing itself: pass the rows.
 */
export async function ingestDealsFromTable(
  env: ShowcaseEnv,
  rows: Array<Record<string, unknown>>,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () =>
      env.SPRIGR.collections.ingestFromTable({
        collection: await dealsCollection(env),
        rows,
        mapping: { 'Deal ID': 'deal_id', Stage: 'stage', Amount: 'amount' },
      }),
    'ingestDealsFromTable calls env.SPRIGR.collections.ingestFromTable — publish to staging.',
  );
}

export async function queryDeals(env: ShowcaseEnv, stage: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () =>
      env.SPRIGR.collections.query({
        collection: await dealsCollection(env),
        filters: `stage:${stage}`,
        facets: ['stage'],
        hits_per_page: 50,
      }),
    'queryDeals calls env.SPRIGR.collections.query — publish to staging.',
  );
}

/**
 * Diff Acme's current deals against the stored ones by deal_id. Read-only:
 * it reports added / missing (gap) / changed counts plus a sample of each,
 * and writes nothing. Commit what you decide with ingest.
 */
export async function reconcileDeals(env: ShowcaseEnv, liveDeals: Deal[]): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () =>
      env.SPRIGR.collections.reconcile({
        collection: await dealsCollection(env),
        against: { records: liveDeals },
        match: { key: ['deal_id'] },
      }),
    'reconcileDeals calls env.SPRIGR.collections.reconcile, a read-only diff. Publish to staging.',
  );
}

export async function describeDeals(env: ShowcaseEnv): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () => env.SPRIGR.collections.describe({ collection: await dealsCollection(env) }),
    'describeDeals calls env.SPRIGR.collections.describe — publish to staging.',
  );
}

/**
 * Field-level change log for one record. `objectId` is the record's objectID
 * from a query hit. The platform derives it from the key, so it is not the
 * deal_id itself.
 */
export async function dealHistory(env: ShowcaseEnv, objectId: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    async () => env.SPRIGR.collections.history({ collection: await dealsCollection(env), object_id: objectId, limit: 50 }),
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

/**
 * Rename a warehouse or change its capability flags, keyed by the same
 * serviceKey you registered with. This is how you correct a service in
 * place; delete-and-re-register would orphan the Shopify Location and any
 * fulfillment orders already routed to it.
 */
export async function renameWarehouse(
  env: ShowcaseEnv,
  integrationId: string,
  warehouse: { key: string; newName: string; trackingSupport?: boolean },
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () =>
      env.SPRIGR.fulfillment_services.update({
        platform: 'shopify',
        integrationId,
        serviceKey: warehouse.key,
        serviceName: warehouse.newName,
        ...(warehouse.trackingSupport === undefined
          ? {}
          : { trackingSupport: warehouse.trackingSupport }),
      }),
    'renameWarehouse calls env.SPRIGR.fulfillment_services.update — publish to staging.',
  );
}

/**
 * Deregister a warehouse. Destructive on the provider side — the Shopify
 * FulfillmentService and its Location go away — so only call it once the
 * location has no open fulfillment orders.
 */
export async function deregisterWarehouse(
  env: ShowcaseEnv,
  integrationId: string,
  serviceKey: string,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.fulfillment_services.delete({ platform: 'shopify', integrationId, serviceKey }),
    'deregisterWarehouse calls env.SPRIGR.fulfillment_services.delete — publish to staging.',
  );
}

// ── cross-tenant / interface implementation ──────────────────────────────────
/**
 * The handler behind cross_tenant_tools[].showcase_lookup_contact, which the
 * manifest also tags `provides: showcase/contact_lookup op lookup_contact`
 * (decision 0077). A consumer bound to this app reaches it through
 * env.SPRIGR.invoke('showcase_lookup_contact', { contact_id }), dispatched to
 * /__sprigr/tool/<name>, which is why it MUST also be in tools[] (the build
 * derives the handler map from tools[] entries with a handler). Returns the
 * interface's declared output shape: { found, contact? }.
 */
export async function lookupContact(env: ShowcaseEnv, contactId: string): Promise<{ found: boolean; contact?: unknown }> {
  if (!contactId) return { found: false };
  const got = await getContact(env, contactId);
  if (!got.ok) return { found: false };
  const contact = (got as { result?: unknown }).result;
  return contact ? { found: true, contact } : { found: false };
}

export default {
  showcase_lookup_contact: (args: { contact_id: string }, env: ShowcaseEnv) => lookupContact(env, args?.contact_id ?? ''),
};

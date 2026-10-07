/**
 * Home Contracts: the curated `sprigr/` contract definitions (FINAL-APP-FEEDS
 * section 3, open decision 3). These are the seed: the first curated
 * `sprigr/` interface definitions for the decision 0077 registry, in the
 * registry's own definition shape, so a later slice can write them through
 * the platform seed path (the app slug `sprigr` is reserved, so no publish can
 * define them) with no translation.
 *
 * Every schema here is GENERATED from the same field specs the validator uses
 * (records.ts), never written by hand, so the published contract and the
 * runtime check cannot drift. A published `(id, version)` is immutable by
 * content hash (0077): a test pins each definition's hash, so changing a
 * served version is a failing test, and the fix is a new minor.
 *
 * `consumers: 'owner'`: only the definition's owner, the platform, may bind
 * to a Home contract (the closed-consumer rule). Apps implement Home
 * contracts through the manifest `home` block, never through `provides` tags
 * or `app_dependencies` (manifest.ts refuses both).
 *
 * Self-contained, so it lifts into `@sprigr/apps-home` unchanged.
 */

import {
  HOME_CONTRACT_IDS,
  HOME_CONTRACT_NAMESPACE,
  HOME_CONTRACT_SERVED_VERSIONS,
  type HomeContractId,
  type HomeSensitivityTag,
} from './vocabulary';
import { flattenHomeFields, homeJsonSchema } from './schema';
import { HOME_RECORD_FIELDS, HOME_RECORD_NAMES, HOME_REQUEST_FIELDS, homeResultFields } from './records';

/** Structurally the 0077 `AppInterfaceDefinition` (a drift test checks it passes `validateInterfaces`). */
export interface HomeContractDefinition {
  name: string;
  version: string;
  description: string;
  consumers: 'owner';
  ops: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
  }>;
  records: Array<{
    name: string;
    description: string;
    fields: Record<string, { type: 'string' | 'number' | 'date' | 'boolean'; sensitivity?: HomeSensitivityTag[] }>;
  }>;
}

/** The one op every Home contract has: answer one provider for the person the platform stamped. */
export const HOME_CONTRACT_OP = 'answer';

const DESCRIPTIONS: Readonly<Record<HomeContractId, string>> = {
  'sprigr/home_schedule':
    "Timed and all-day items on a person's or a crew's day: jobs, meetings, deliveries. Feeds the Home band, Next, the tomorrow fold and Crew. " +
    'Cross-field rules: start unless all_day; end for block and window, after start; day for all_day; person when the request scope is crew; issuer on every *_ref subject.',
  'sprigr/home_queue':
    'Things waiting on someone, with a closed reason and why, never a rank. The platform assigns the tier against its own clock. ' +
    'Cross-field rules: severity only on reason broken; expires_at on reason expires; reason and why within the provider declaration.',
  'sprigr/home_metrics':
    'Business figures with a closed metric id: money in integer minor units, or counts. Never summed across sources or currencies. ' +
    'Cross-field rules: a day period equals the request basis day; compare has the same kind and currency as value; one row per metric and currency.',
  'sprigr/home_subject_facts':
    'Facts about a customer or job keyed by exact join subjects, for prep lines and hover cards. Bulk mode at most 500 records, ref mode at most 20. ' +
    'Cross-field rules: text only on last_visit_note; fact within the provider declaration.',
  'sprigr/home_identity':
    'A status read of who the viewer is in the vendor: their connection, the vendor "who am I", and a people list for matching. Never mints anything. ' +
    'One record per answer; emails are dropped by the platform after matching.',
};

function definitionFor(contract: HomeContractId, version: string): HomeContractDefinition {
  const fields = HOME_RECORD_FIELDS[contract];
  const recordFields: HomeContractDefinition['records'][number]['fields'] = {};
  for (const f of flattenHomeFields(fields)) {
    recordFields[f.path] = f.sensitivity.length > 0 ? { type: f.type, sensitivity: f.sensitivity } : { type: f.type };
  }
  return {
    name: contract.slice(HOME_CONTRACT_NAMESPACE.length + 1),
    version,
    description: DESCRIPTIONS[contract],
    consumers: 'owner',
    ops: [
      {
        name: HOME_CONTRACT_OP,
        description:
          "Answer one provider of this contract for the person the platform stamped as actor. Input is the platform-built HomeRequest (args._home); output is a HomeResult whose basis echoes the request's.",
        input_schema: homeJsonSchema({ type: 'object', fields: HOME_REQUEST_FIELDS }),
        output_schema: homeJsonSchema({
          type: 'object',
          fields: homeResultFields(contract, { type: 'object', fields }),
        }),
      },
    ],
    records: [
      {
        name: HOME_RECORD_NAMES[contract],
        description: 'One record of this contract. Sensitivity tags are assigned by the platform; an app cannot change them.',
        fields: recordFields,
      },
    ],
  };
}

/**
 * Every curated Home contract definition at every served version, oldest
 * version first within each contract. Ids are `sprigr/<name>`.
 */
export function homeContractDefinitions(): Array<{ id: HomeContractId; definition: HomeContractDefinition }> {
  const out: Array<{ id: HomeContractId; definition: HomeContractDefinition }> = [];
  for (const id of HOME_CONTRACT_IDS) {
    for (const version of HOME_CONTRACT_SERVED_VERSIONS[id]) out.push({ id, definition: definitionFor(id, version) });
  }
  return out;
}

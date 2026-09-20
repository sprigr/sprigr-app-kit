/**
 * Manifest-level conformance: the half of the contract that is declaration,
 * not behaviour.
 *
 * The runtime suites cannot see any of this. A handler map can be perfect
 * while the manifest tags the wrong op name, pins the wrong interface
 * version, or forgets to declare the event the hub is waiting on, and every
 * one of those fails at INSTALL or, worse, silently at runtime: an
 * undeclared emit is dropped, and a mis-tagged op is simply never bound, so
 * the hub sees an adapter that provides nothing rather than an error.
 */

import {
  EVENTS_BY_ROLE,
  EVENT_PREFIX_BY_ROLE,
  INTERFACE_IDS,
  INTERFACE_VERSION,
  OPS_BY_ROLE,
  REQUIRED_EMITS_BY_OP,
  toolNameFor,
  type AdapterRole,
} from './contract';
import { CheckCollector, type ConformanceReport } from './report';
import { isPlainObject } from './shape';

export interface ManifestCheckOptions {
  /**
   * Contract ops this adapter is allowed to leave unclaimed. Empty by
   * default: the interface exists so the hub can swap one adapter for
   * another, and a partial implementer breaks that the first time the hub
   * dispatches an op nobody bound.
   */
  allowUnclaimedOps?: readonly string[];
}

interface ProvidesTag {
  interface?: unknown;
  op?: unknown;
  version?: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function checkAdapterManifest(
  manifest: unknown,
  role: AdapterRole,
  opts: ManifestCheckOptions = {},
): ConformanceReport {
  const checks = new CheckCollector();
  const interfaceId = INTERFACE_IDS[role];
  const contractOps = OPS_BY_ROLE[role];
  const contractOpNames = contractOps.map((o) => o.name);

  if (!isPlainObject(manifest)) {
    checks.fail('manifest.parsed', 'the manifest is not an object');
    return checks.report();
  }

  const metadata = isPlainObject(manifest.metadata) ? manifest.metadata : {};
  const slug = typeof metadata.slug === 'string' ? metadata.slug : '';
  checks.add(
    'manifest.slug',
    slug.length > 0,
    slug.length > 0 ? `metadata.slug=${slug}` : 'metadata.slug is required; every tool name is derived from it',
  );

  const tools = asArray(manifest.tools).filter(isPlainObject);
  const toolByName = new Map(
    tools.filter((t) => typeof t.name === 'string').map((t) => [t.name as string, t]),
  );

  // --- the provides tags -----------------------------------------------
  const crossTenant = asArray(manifest.cross_tenant_tools).filter(isPlainObject);
  const tagged = crossTenant.filter((t) => {
    const p = t.provides as ProvidesTag | undefined;
    return isPlainObject(p) && p.interface === interfaceId;
  });

  checks.add(
    'provides.any',
    tagged.length > 0,
    tagged.length > 0
      ? `${tagged.length} cross-tenant tool(s) tagged provides.interface=${interfaceId}`
      : `no cross_tenant_tools entry carries provides.interface="${interfaceId}". Without a provides tag the platform never binds this app to the hub (decision 0077).`,
  );

  const claimed = new Map<string, Record<string, unknown>>();
  for (const entry of tagged) {
    const provides = entry.provides as ProvidesTag;
    const toolName = typeof entry.tool_name === 'string' ? entry.tool_name : '<missing tool_name>';
    const opName = typeof provides.op === 'string' ? provides.op : '<missing op>';

    const known = contractOpNames.includes(opName);
    checks.add(
      `provides.${opName}.is_a_contract_op`,
      known,
      known
        ? `${opName} is an op of ${interfaceId}`
        : `"${opName}" is not an op of ${interfaceId} (ops: ${contractOpNames.join(', ')})`,
    );
    if (!known) continue;

    if (claimed.has(opName)) {
      checks.fail(`provides.${opName}.claimed_once`, `op ${opName} is claimed by more than one tool`);
      continue;
    }
    claimed.set(opName, entry);

    checks.add(
      `provides.${opName}.version`,
      provides.version === INTERFACE_VERSION,
      provides.version === INTERFACE_VERSION
        ? `pinned at ${INTERFACE_VERSION}`
        : `provides.version must be the exact "${INTERFACE_VERSION}"; got ${JSON.stringify(provides.version)}. The hub requires ^1 and reads the pin to decide what it may call.`,
    );

    const expected = toolNameFor(slug, opName);
    checks.add(
      `provides.${opName}.tool_name`,
      toolName === expected,
      toolName === expected
        ? `${toolName}`
        : `a provides-tagged tool must be named <slug_with_underscores>_<op>: expected "${expected}", got "${toolName}". Publish refuses anything else.`,
    );

    const tool = toolByName.get(toolName);
    checks.add(
      `provides.${opName}.in_tools`,
      tool !== undefined,
      tool !== undefined
        ? `${toolName} is declared in tools[]`
        : `${toolName} is tagged in cross_tenant_tools[] but missing from tools[]. Publish refuses; the handler would never be dispatched.`,
    );
    if (tool) {
      const handler = tool.handler;
      checks.add(
        `provides.${opName}.handler`,
        typeof handler === 'string' && handler.length > 0,
        typeof handler === 'string' && handler.length > 0
          ? `handler ${handler}`
          : `tools[] entry "${toolName}" has no handler file`,
      );
      const spec = contractOps.find((o) => o.name === opName);
      if (spec?.effects === 'write') {
        checks.add(
          `provides.${opName}.effects_write`,
          tool.effects === 'write',
          tool.effects === 'write'
            ? 'declares effects: "write"'
            : `${opName} is a write op, so tools[] entry "${toolName}" must declare effects: "write". Without it the platform's name heuristic decides the dispatch tier and may blind-retry a push after a timeout.`,
        );
      }
    }
  }

  const allowUnclaimed = new Set(opts.allowUnclaimedOps ?? []);
  // An op added after 1.0.0 (`optionalSince`) cannot be required of an adapter
  // written before it existed, so it is never "missing" here. The consumer
  // gates on the matching `describe` capability; an adapter that claims the
  // binding is still held to the op's shape and behaviour everywhere else.
  const addedLater = new Set(
    contractOps.filter((o) => typeof o.optionalSince === 'string').map((o) => o.name),
  );
  const missing = contractOpNames.filter(
    (n) => !claimed.has(n) && !allowUnclaimed.has(n) && !addedLater.has(n),
  );
  checks.add(
    'provides.covers_every_op',
    missing.length === 0,
    missing.length === 0
      ? `all ${contractOpNames.length} ops of ${interfaceId} are claimed`
      : `unclaimed ops: ${missing.join(', ')}. The hub dispatches by op and cannot tell a missing binding from a broken adapter.`,
  );

  // --- events ------------------------------------------------------------
  const events = isPlainObject(manifest.events) ? manifest.events : {};
  const emits = asArray(events.emits).filter(isPlainObject);
  const emitted = new Set(
    emits.filter((e) => typeof e.name === 'string').map((e) => e.name as string),
  );
  const prefix = EVENT_PREFIX_BY_ROLE[role];
  const known = new Set<string>(EVENTS_BY_ROLE[role]);

  const stray = [...emitted].filter((n) => n.startsWith(prefix) && !known.has(n));
  checks.add(
    'events.names_are_contract_events',
    stray.length === 0,
    stray.length === 0
      ? `every "${prefix}*" emit is a contract event`
      : `declared but not in the contract: ${stray.join(', ')}. The hub subscribes by exact name, so a typo emits into the void.`,
  );

  const required = new Set<string>();
  for (const [opName, names] of Object.entries(REQUIRED_EMITS_BY_OP[role])) {
    if (opName === '*' || claimed.has(opName)) for (const n of names) required.add(n);
  }
  const missingEmits = [...required].filter((n) => !emitted.has(n));
  checks.add(
    'events.required_emits_declared',
    missingEmits.length === 0,
    missingEmits.length === 0
      ? required.size === 0
        ? 'no contract event is required by the claimed ops'
        : `declares ${[...required].join(', ')}`
      : `missing from events.emits[]: ${missingEmits.join(', ')}. Every write op acknowledges asynchronously, so the hub learns the outcome only from these events; an undeclared emit is dropped by the platform.`,
  );

  return checks.report();
}

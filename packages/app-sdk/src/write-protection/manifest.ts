/**
 * Apply confirmation policies to a parsed `sprigr-app.json`, for an app's
 * `gen:confirmation` script and its drift-guard test.
 *
 * Pure: takes the parsed manifest, mutates it in place, returns what it
 * touched. The script owns the two lines of file I/O around it, so this
 * module stays free of `node:fs` and safe to bundle into a Worker.
 *
 * Besides writing each policy, it retires the two mechanisms a policy
 * supersedes: the legacy `confirmation_required` flag (a bare
 * `{ always: true }` with no describe) and any app-declared `confirm` input
 * (the platform injects its own top-level `confirm` wherever a policy is
 * present). Both are stripped from EVERY tool, not only the gated ones,
 * because a stray copy on an ungated tool is how a handler ends up reading
 * a flag nothing enforces.
 */

import type { ConfirmationPolicy } from './types';

export interface ManifestDispatchBlock {
  actionField: string;
  actions: string[];
  actionInputs?: Record<string, { accepts: string[]; required?: string[] }>;
}

export interface ManifestToolLike {
  name: string;
  input_schema?: { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  confirmation?: unknown;
  confirmation_required?: boolean;
  dispatch?: unknown;
  [k: string]: unknown;
}

export interface ManifestLike {
  tools?: ManifestToolLike[];
  [k: string]: unknown;
}

export interface ApplyPoliciesOptions {
  /** Tool name -> its policy: a tool-level rule, or `{ actions }` for a dispatcher. */
  policies: Readonly<Record<string, ConfirmationPolicy>>;
  /** Tool name -> dispatch block to write alongside (dispatchers only). */
  dispatch?: Readonly<Record<string, ManifestDispatchBlock>>;
  /** Delete `confirmation_required` from every tool. Default true. */
  stripLegacyFlag?: boolean;
  /** Delete an app-declared `confirm` input (property + required entry) from every tool. Default true. */
  dropConfirmParam?: boolean;
}

/**
 * Write the policies (and dispatch blocks) onto the named tools in place.
 * Throws when a policy names a tool the manifest does not have, so a
 * renamed tool cannot silently lose its gate. Returns the tool names touched.
 */
export function applyConfirmationPolicies(manifest: ManifestLike, opts: ApplyPoliciesOptions): string[] {
  const tools = manifest.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const touched: string[] = [];
  for (const [name, policy] of Object.entries(opts.policies)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`applyConfirmationPolicies: no tool named '${name}' in the manifest`);
    tool.confirmation = policy;
    touched.push(name);
  }
  for (const [name, block] of Object.entries(opts.dispatch ?? {})) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`applyConfirmationPolicies: no tool named '${name}' in the manifest (dispatch)`);
    tool.dispatch = block;
    if (!touched.includes(name)) touched.push(name);
  }
  const stripLegacy = opts.stripLegacyFlag ?? true;
  const dropConfirm = opts.dropConfirmParam ?? true;
  for (const tool of tools) {
    if (stripLegacy) delete tool.confirmation_required;
    if (dropConfirm) {
      const schema = tool.input_schema;
      if (schema?.properties && 'confirm' in schema.properties) delete schema.properties.confirm;
      if (schema?.required?.includes('confirm')) {
        schema.required = schema.required.filter((k) => k !== 'confirm');
        if (schema.required.length === 0) delete schema.required;
      }
    }
  }
  return touched;
}

/**
 * True when applying the policies to a copy of the manifest changes nothing:
 * the committed file is a fresh generation. The drift-guard test's one call.
 */
export function manifestIsFresh(manifest: ManifestLike, opts: ApplyPoliciesOptions): boolean {
  const copy = JSON.parse(JSON.stringify(manifest)) as ManifestLike;
  applyConfirmationPolicies(copy, opts);
  return JSON.stringify(copy) === JSON.stringify(manifest);
}

/** The manifest, serialised the way the repo commits it (2-space, trailing newline). */
export function serializeManifest(manifest: ManifestLike): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

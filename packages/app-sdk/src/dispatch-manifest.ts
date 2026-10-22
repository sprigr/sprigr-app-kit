/**
 * Build a dispatcher tool's manifest `dispatch` block from an app's action
 * registry (sprigr-app-kit#170).
 *
 * The block (`AppToolDeclaration['dispatch']` in sprigr-team's
 * packages/shared/src/types/marketplace.ts) lets the platform:
 *   - reject a workflow step naming an action outside the catalogue at publish
 *     time instead of mid-run;
 *   - refuse an input key an action does not read (`actionInputs`), instead of
 *     the app silently dropping it and returning a wrong result;
 *   - show a code_mode agent one line per action under `tools.describe`
 *     (`actionDescriptions`, sprigr-apps#3701, rendered by sprigr-team#12577).
 *
 * Seven apps carried their own copy of this logic in
 * `scripts/gen-dispatch-manifest.ts`. These builders are the pure part, ported
 * from simpro 0.6.4 (sprigr-apps#3702). Each app keeps its own manifest I/O and
 * the policies that are not about the catalogue (confirmation, idempotency).
 */

import type { ManifestDispatchBlock } from './write-protection/manifest';

/** What a builder needs from one action definition. */
export interface DispatchActionSpec {
  /** The canonical name. An alias entry points at the same spec under another key. */
  name: string;
  description?: string;
  /** A short summary preferred over the description's first sentence. */
  summary?: string;
  /**
   * Every input key the action's parseInput reads. Declare it only when it is
   * complete: the platform refuses any other key before dispatch.
   */
  accepts?: readonly string[];
  /** Keys that must be present (a subset of `accepts`). An app maps its own field here. */
  required?: readonly string[];
}


/**
 * Longest line emitted into `actionDescriptions`. A `tools.describe` page holds
 * 30k chars and an app can have hundreds of actions, so a line is a summary;
 * the full description stays reachable through the app's own describe action.
 * The renderers print the line verbatim, so the generator owns the length.
 */
export const ACTION_DESCRIPTION_MAX_CHARS = 160;

/** Abbreviations whose trailing dot does not end a sentence. */
const NON_TERMINAL = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|incl)\.$/i;

/**
 * The one line for an action: its `summary` when it declares one, else the
 * first sentence of its `description`. A line over `maxChars` is cut on a word
 * boundary and ends in "..." so the cut is visible. No text gives "".
 */
export function oneLineDescription(
  def: { description?: string; summary?: string },
  maxChars: number = ACTION_DESCRIPTION_MAX_CHARS,
): string {
  let line = (def.summary ?? '').trim();
  if (!line) {
    const text = (def.description ?? '').replace(/\s+/g, ' ').trim();
    line = text;
    const re = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const head = text.slice(0, m.index + 1);
      // Not inside an open bracket: "(building a whole new quote? use ...)"
      // is part of the first sentence, not its end.
      const open = (head.match(/\(/g) ?? []).length - (head.match(/\)/g) ?? []).length;
      if (open <= 0 && !NON_TERMINAL.test(head)) { line = head; break; }
    }
  }
  line = line.replace(/\s+/g, ' ');
  if (line.length <= maxChars) return line;
  const room = maxChars - 3;
  const cut = line.slice(0, room);
  const space = cut.lastIndexOf(' ');
  return `${(space > room / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}...`;
}

/**
 * The `dispatch` block for a registry keyed by CALLABLE name, the
 * `ManifestDispatchBlock` that `applyConfirmationPolicies` writes onto the tool.
 *
 *   - `actions`: every key, sorted. Aliases are real dispatchable names, so a
 *     workflow referencing one must not be flagged as unknown.
 *   - `actionInputs`: only actions whose spec declares `accepts`, keyed by the
 *     canonical `name` (so an alias never appears twice). Never fabricated for
 *     an action that forwards arbitrary passthrough params.
 *   - `actionDescriptions`: one line per callable name, so a lookup by the name
 *     an agent called finds its line; an action with no text is omitted.
 *     `descriptions: false` leaves the key out.
 */
export function buildDispatchManifest(
  registry: ReadonlyMap<string, DispatchActionSpec>,
  opts: { actionField?: string; descriptions?: boolean } = {},
): ManifestDispatchBlock {
  const actions = Array.from(registry.keys()).sort((a, b) => a.localeCompare(b));

  const actionInputs: Record<string, { accepts: string[]; required?: string[] }> = {};
  for (const def of registry.values()) {
    if (!Array.isArray(def.accepts)) continue;
    const entry: { accepts: string[]; required?: string[] } = { accepts: [...def.accepts] };
    if (Array.isArray(def.required) && def.required.length > 0) {
      entry.required = [...def.required];
    }
    actionInputs[def.name] = entry;
  }

  const dispatch: ManifestDispatchBlock = { actionField: opts.actionField ?? 'action', actions };
  if (Object.keys(actionInputs).length > 0) dispatch.actionInputs = actionInputs;
  if (opts.descriptions !== false) {
    const actionDescriptions: Record<string, string> = {};
    for (const name of actions) {
      const line = oneLineDescription(registry.get(name)!);
      if (line) actionDescriptions[name] = line;
    }
    dispatch.actionDescriptions = actionDescriptions;
  }
  return dispatch;
}

const DEFAULT_PARAMS_INTRO =
  'Action-specific parameters, snake_case, nested under `input`. The actions below declare an ' +
  'input contract and are shown as `name: keys` (one line each, `*` marks a required key); ' +
  "every other action's handler validates its own per-action schema. Call action=list_actions " +
  'for the full catalogue with one-line descriptions.';

/**
 * The dispatcher's `input` description: `intro`, a blank line, then one
 * `name: keys` line per declared contract (sorted, `*` marking a required
 * key). Only declared contracts are listed, so the text stays short for an
 * app where most actions validate their own input.
 */
export function buildParamsDescription(
  actionInputs: ManifestDispatchBlock['actionInputs'],
  intro: string = DEFAULT_PARAMS_INTRO,
): string {
  const inputs = actionInputs ?? {};
  const lines = [intro, ''];
  const sorted = Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, { accepts, required }] of sorted) {
    const requiredKeys = new Set(required ?? []);
    lines.push(`${name}: ${accepts.map((k) => (requiredKeys.has(k) ? `${k}*` : k)).join(', ')}`);
  }
  return lines.join('\n');
}

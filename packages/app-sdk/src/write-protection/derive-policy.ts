/**
 * Derive a confirmation policy from an action registry by NAME, for apps
 * whose registry carries no destructive flag: the verb prefix says what an
 * action does (`delete_`, `void_`, `cancel_`, `archive_`), so the policy
 * follows from a small table of verb rules instead of a hand-kept list
 * that drifts the moment an action is added.
 *
 * Each rule names a prefix (or regex), the tier it lands in, and how to
 * phrase the describe from the rest of the name. The first matching rule
 * wins, so put the specific ones first.
 */

import { buildConfirmationPolicy } from './confirmation-policy';
import type { ConfirmRule, ConfirmationPolicy } from './types';

export interface VerbRule {
  /** A name prefix (`'delete_'`) or a regex tested against the whole name. */
  match: string | RegExp;
  /** `irreversible` marks the card "cannot be undone"; `always` is a plain confirmation. */
  tier: 'irreversible' | 'always';
  /**
   * Describe for a matching action. Receives the full name and `rest`: the
   * name with the matched prefix removed and underscores turned to spaces
   * (for a regex match, the whole name spaced). No trailing period.
   */
  describe: (name: string, rest: string) => string;
}

export interface DerivePolicyOptions {
  /** Verb rules, most specific first. */
  rules: readonly VerbRule[];
  /** Actions to leave ungated even though a rule matches (returned in `ungated`). */
  exempt?: readonly string[];
  /** Explicit rules that win over the verb table (e.g. a hand-written describe). */
  overrides?: Readonly<Record<string, ConfirmRule>>;
}

export interface DerivedPolicy {
  policy: ConfirmationPolicy & { actions: Record<string, ConfirmRule> };
  /** Registry names a rule matched but `exempt` kept ungated. */
  ungated: string[];
  /** Registry names no rule matched (reads and writes the table does not classify). */
  unmatched: string[];
}

function spaced(s: string): string {
  return s.replace(/_/g, ' ');
}

function matchRule(name: string, rule: VerbRule): string | null {
  if (typeof rule.match === 'string') {
    return name.startsWith(rule.match) ? spaced(name.slice(rule.match.length)) : null;
  }
  return rule.match.test(name) ? spaced(name) : null;
}

/** Build a policy over `registry` from the verb table; see the file comment. */
export function deriveConfirmationPolicy(registry: Iterable<string>, opts: DerivePolicyOptions): DerivedPolicy {
  const exempt = new Set(opts.exempt ?? []);
  const irreversible: Record<string, string> = {};
  const always: Record<string, string> = {};
  const ungated: string[] = [];
  const unmatched: string[] = [];
  const overrides = opts.overrides ?? {};
  for (const name of registry) {
    if (overrides[name]) continue;
    let hit = false;
    for (const rule of opts.rules) {
      const rest = matchRule(name, rule);
      if (rest == null) continue;
      hit = true;
      if (exempt.has(name)) ungated.push(name);
      else (rule.tier === 'irreversible' ? irreversible : always)[name] = rule.describe(name, rest);
      break;
    }
    if (!hit) unmatched.push(name);
  }
  const policy = buildConfirmationPolicy({ irreversible, always, rules: overrides }) as ConfirmationPolicy & {
    actions: Record<string, ConfirmRule>;
  };
  return { policy, ungated, unmatched };
}

/**
 * The verb table most registries need: hard deletes, voids, refunds and
 * cancellations cannot be undone; archives, removals from a parent and
 * unassignments are plain confirmations. `subject` names the system for
 * the describe ("in Xero").
 */
export function commonDestructiveVerbs(subject: string): VerbRule[] {
  const where = subject ? ` ${subject}` : '';
  return [
    { match: 'delete_', tier: 'irreversible', describe: (_n, rest) => `Delete ${rest}${where}` },
    { match: 'void_', tier: 'irreversible', describe: (_n, rest) => `Void ${rest}${where}` },
    { match: 'refund_', tier: 'irreversible', describe: (_n, rest) => `Refund ${rest}${where}` },
    { match: 'cancel_', tier: 'irreversible', describe: (_n, rest) => `Cancel ${rest}${where}` },
    { match: 'destroy_', tier: 'irreversible', describe: (_n, rest) => `Destroy ${rest}${where}` },
    { match: 'purge_', tier: 'irreversible', describe: (_n, rest) => `Purge ${rest}${where}` },
    { match: 'revoke_', tier: 'irreversible', describe: (_n, rest) => `Revoke ${rest}${where}` },
    { match: 'archive_', tier: 'always', describe: (_n, rest) => `Archive ${rest}${where}` },
    { match: 'remove_', tier: 'always', describe: (_n, rest) => `Remove ${rest}${where}` },
    { match: 'unassign_', tier: 'always', describe: (_n, rest) => `Unassign ${rest}${where}` },
    { match: 'deactivate_', tier: 'always', describe: (_n, rest) => `Deactivate ${rest}${where}` },
  ];
}

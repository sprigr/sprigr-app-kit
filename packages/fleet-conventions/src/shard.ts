/**
 * @sprigr/apps-fleet-conventions: the fleet's odd/even issue shard rule.
 *
 * Ported byte-for-byte (apart from this header) from sprigr-team
 * `packages/shared/src/utils/fleet-shard.ts`, so the platform
 * (`@sprigr/team-shared`) and the github marketplace app share one
 * implementation. The file paths named in the doc comments below point into
 * sprigr-team, where the consumers live.
 */

/**
 * The single source of truth for the fleet's issue-number SHARD rule.
 *
 * Since 2026-08-09 the fleet splits work by issue-number PARITY across every
 * sprigr repo: the primary Dev Fixer owns ODD, Dev Fixer B owns EVEN, and the
 * two Issue Diagnosticians split the same way. Parity balances the load ~50/50,
 * depends on nothing mutable (labels change, the number never does), and both
 * halves still prioritise severity WITHIN their shard.
 *
 * Three surfaces need the rule and used to state it separately: the personas
 * (prose), the fleet event router (`workers/provisioning/src/github-event-router.ts`),
 * and now the `github` tool's `list_issues` candidate scan. This module is the
 * one definition they share, in the same spirit as `fleet-verdict.ts`.
 *
 * WHY THE TOOL FILTERS AT ALL (sprigr-team#6581). The shard was enforced only
 * by a model choosing to obey an instruction on each pick, and it was measured
 * being violated in both directions: seven `fix/issue-*` branches (the ODD
 * owner) opened on EVEN issues, and one `fixb/issue-*` branch on an ODD issue.
 * #6598 was implemented twice as a result (PRs #6603 and #6604, the second
 * discarded as a duplicate). Rewording the personas did not close it: the
 * expired `(no shard test while you are the only fixer)` carve-out was deleted
 * in PR #6648 and verified live, and a violation still landed 4h10m later.
 * A wrong-parity issue the agent can see is a wrong-parity issue the agent can
 * pick, so the fix is to keep it out of the candidate list.
 */

/** Which half of the fleet an issue number belongs to. */
export type ShardParity = 'odd' | 'even';

/**
 * The parity of an issue number. Non-integers are not issue numbers and have
 * no shard; callers must fail OPEN on `null` (show the item) rather than hide
 * something they could not classify.
 */
export function issueShardParity(issueNumber: number): ShardParity | null {
  if (!Number.isInteger(issueNumber)) return null;
  return Math.abs(issueNumber) % 2 === 1 ? 'odd' : 'even';
}

/** The agent slug that owns each parity, per family. */
export const FLEET_SHARD_OWNERS = {
  fixer: { odd: 'dev-fixer', even: 'dev-fixer-b' },
  diagnostician: { odd: 'issue-diagnostician-v2', even: 'issue-diagnostician-b' },
} as const;

/**
 * Agent slugs whose `list_issues` results are shard-filtered inside the tool.
 *
 * DELIBERATELY THE TWO FIXERS ONLY. The diagnosticians declare the same shard
 * rule, but their cycle opens with a step-0 recovery sweep that is
 * parity-EXEMPT on purpose (repairing a stranded filing costs no deep_task),
 * and #6581's own diagnosis records "keep the recovery-sweep exemption
 * parity-exempt" as a must-not-regress. A blanket filter keyed on the
 * diagnostician slugs would take that exemption away, so adding them here
 * needs an opt-out for the sweep first. The owner ruling on #6581 also voided
 * the diagnostician half of the issue: no diagnostician-side crossing was ever
 * measured (the `[diagnostician]` prefix is a shared ROLE string and cannot
 * identify an agent).
 */
const SHARD_FILTERED_AGENT_SLUGS: Readonly<Record<string, ShardParity>> = {
  [FLEET_SHARD_OWNERS.fixer.odd]: 'odd',
  [FLEET_SHARD_OWNERS.fixer.even]: 'even',
};

/**
 * The parity an agent may work, or `null` for every agent outside the sharded
 * fleet (which is almost all of them: a normal company agent must never have
 * its issue list silently halved).
 */
export function shardParityForAgentSlug(slug: string | null | undefined): ShardParity | null {
  if (!slug) return null;
  return SHARD_FILTERED_AGENT_SLUGS[slug] ?? null;
}

/**
 * Is this issue number inside `parity`'s shard? Unclassifiable numbers answer
 * `true` (fail open) for the reason given on `issueShardParity`.
 */
export function isInShard(issueNumber: number, parity: ShardParity): boolean {
  const own = issueShardParity(issueNumber);
  return own === null || own === parity;
}

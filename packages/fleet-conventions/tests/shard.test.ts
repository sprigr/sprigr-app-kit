import { describe, expect, it } from 'vitest';
import {
  FLEET_SHARD_OWNERS,
  isInShard,
  issueShardParity,
  shardParityForAgentSlug,
} from '../src/index';

/**
 * sprigr-team#6581. The shard was prose-only, and prose was measured losing:
 * seven `fix/issue-*` branches (the ODD owner) on EVEN issues, one `fixb/` on
 * an ODD issue, and #6598 implemented twice. These pin the rule the github
 * tool now enforces on the fixers' candidate scan.
 */
describe('fleet shard parity', () => {
  it('splits issue numbers the way both personas and the event router state', () => {
    expect(issueShardParity(6581)).toBe('odd');
    expect(issueShardParity(6598)).toBe('even');
    // The two numbers from the measured double-fix: 6598 is B's, and the
    // primary opened fix/issue-6598 on it anyway.
    expect(FLEET_SHARD_OWNERS.fixer[issueShardParity(6598)!]).toBe('dev-fixer-b');
    expect(FLEET_SHARD_OWNERS.fixer[issueShardParity(4391)!]).toBe('dev-fixer');
  });

  it('has no parity for a non-integer, so nothing gets hidden on a value it could not classify', () => {
    expect(issueShardParity(Number.NaN)).toBeNull();
    expect(issueShardParity(6.5)).toBeNull();
    expect(isInShard(Number.NaN, 'odd')).toBe(true);
    expect(isInShard(Number.NaN, 'even')).toBe(true);
  });

  it('answers isInShard from the number alone, never from severity or repo', () => {
    expect(isInShard(4391, 'odd')).toBe(true);
    expect(isInShard(4391, 'even')).toBe(false);
    expect(isInShard(6546, 'even')).toBe(true);
    expect(isInShard(6546, 'odd')).toBe(false);
  });

  it('maps the two fixer slugs to their parity and every other agent to none', () => {
    expect(shardParityForAgentSlug('dev-fixer')).toBe('odd');
    expect(shardParityForAgentSlug('dev-fixer-b')).toBe('even');
    // A normal company agent must never have its issue list silently halved.
    expect(shardParityForAgentSlug('tech-lead-reviewer')).toBeNull();
    expect(shardParityForAgentSlug('triage-analyst')).toBeNull();
    expect(shardParityForAgentSlug('assistant')).toBeNull();
    expect(shardParityForAgentSlug(undefined)).toBeNull();
    expect(shardParityForAgentSlug('')).toBeNull();
  });

  /**
   * The diagnosticians declare the same shard but open their cycle with a
   * parity-EXEMPT recovery sweep, and #6581's diagnosis lists keeping that
   * exemption as a must-not-regress. Adding them to the filtered set without
   * an opt-out for the sweep would break it, so this asserts the omission is
   * deliberate rather than an oversight someone should "complete".
   */
  it('does NOT filter the diagnosticians, whose step-0 recovery sweep is parity-exempt', () => {
    expect(shardParityForAgentSlug(FLEET_SHARD_OWNERS.diagnostician.odd)).toBeNull();
    expect(shardParityForAgentSlug(FLEET_SHARD_OWNERS.diagnostician.even)).toBeNull();
  });
});

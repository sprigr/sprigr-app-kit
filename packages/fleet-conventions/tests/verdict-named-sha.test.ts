import { describe, it, expect } from 'vitest';
import { verdictNamedSha } from '../src/index';

/**
 * #6054: `assertApprovalIsCurrent` compares the head SHA a verdict names
 * against the PR's current head — a strong, server-side freshness check. When
 * no SHA is found it falls back to comparing the verdict's `created_at`
 * against commit committer dates, which its own docstring calls "best-effort
 * only" because committer dates are client-supplied and non-monotonic (a
 * rebase or amend can produce a "new" commit dated BEFORE the approve).
 *
 * The reader only matched the prose form ("on head `<sha>`"), while
 * seed-fleet-agents.ts mandates a machine marker as the first line of every
 * verdict. The bodies below are real, taken from PRs #6063 / #6092 / #6087 —
 * none of them matched, so every template-compliant verdict silently took the
 * weak path.
 */

describe('verdictNamedSha — real verdict bodies (#6054)', () => {
  it('reads the canonical machine marker', () => {
    const body = '<!-- verdict sha=5087625 -->\n'
      + '[tech-lead-reviewer] VERDICT: APPROVE | Class-b telemetry split, honestly declared';
    expect(verdictNamedSha(body)).toBe('5087625');
  });

  it('reads the marker on a REQUEST_CHANGES verdict too', () => {
    const body = '<!-- verdict sha=086d0e6 -->\n[tech-lead-reviewer]\n\n**VERDICT: REQUEST_CHANGES** — the producer-side fix';
    expect(verdictNamedSha(body)).toBe('086d0e6');
  });

  it('still reads the prose form', () => {
    expect(verdictNamedSha('Round 2 of 2 on head `8b2ecd83c6ad7cd9e0cd3fe008204a732e6ddbc8`'))
      .toBe('8b2ecd83c6ad7cd9e0cd3fe008204a732e6ddbc8');
  });

  it('prefers the marker when a body carries both', () => {
    // The marker is the mandated, machine-generated one; prose may quote an
    // older SHA from a previous round.
    const body = '<!-- verdict sha=aaaaaaa -->\n[tech-lead-reviewer] Round 2 on head `bbbbbbb` — APPROVE';
    expect(verdictNamedSha(body)).toBe('aaaaaaa');
  });

  it('is case-insensitive and tolerates marker whitespace', () => {
    expect(verdictNamedSha('<!--   verdict   sha=ABC1234   -->')).toBe('abc1234');
  });
});

describe('verdictNamedSha — does not invent a SHA', () => {
  it('returns undefined for a verdict naming no head', () => {
    // Must stay undefined so the committer-date fallback still runs for
    // pre-convention verdicts, rather than the gate passing on a wrong SHA.
    expect(verdictNamedSha('[tech-lead-reviewer] VERDICT: APPROVE | looks good')).toBeUndefined();
  });

  it('does not match a bare "head `sha`" mention', () => {
    // Deliberately NOT supported: "the head `abc1234` was reverted" would name
    // a SHA that is not the reviewed one. Only the marker and the "on head"
    // prose form are authoritative.
    expect(verdictNamedSha('### Review — PR #6063, head `5087625`')).toBeUndefined();
  });

  it('ignores a non-hex marker value', () => {
    expect(verdictNamedSha('<!-- verdict sha=not-a-sha -->')).toBeUndefined();
  });
});

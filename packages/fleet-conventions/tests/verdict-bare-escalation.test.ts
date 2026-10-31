import { describe, expect, it } from 'vitest';
import {
  TECH_LEAD_VERDICT_FORM_RE,
  isMalformedVerdictPost,
  isUnactionableRuling,
  parseAnchoredVerdictRuling,
  parseTechLeadVerdict,
} from '../src/index';

// The reviewer posts an escalation as `[tech-lead-reviewer]` then
// `ESCALATE TO A HUMAN | ...`, with no `VERDICT:`. TECH_LEAD_VERDICT_FORM_RE
// only read `VERDICT: ESCALATE`, so every one of these was invisible: not a
// ruling to parseAnchoredVerdictRuling, not unactionable to isUnactionableRuling,
// and a merge gate reading them fell back to whatever older verdict it found
// (or to "no verdict at all", which passes).
//
// Real bodies: the marker, the identity line and the ruling line are verbatim
// from the reviewer's comments on sprigr-team #10975 and #10959 and
// sprigr-private-apps #972. The prose after the ruling is trimmed to its first
// sentence (or a neutral one), since those threads are private.
const REAL_ESCALATIONS: Record<string, string> = {
  'sprigr-team#10975': [
    '<!-- verdict sha=e4cde85 -->',
    '[tech-lead-reviewer]',
    'ESCALATE TO A HUMAN | Third review round on this PR (rounds 1 and 2 were REQUEST_CHANGES), so per policy it goes to a human, not back to the fixer.',
  ].join('\n'),
  'sprigr-team#10959': [
    '<!-- verdict sha=c307b07 -->',
    '[tech-lead-reviewer]',
    'ESCALATE TO A HUMAN | My earlier escalation stands: this PR already had two REQUEST_CHANGES rounds, so a human makes the merge call.',
  ].join('\n'),
  'sprigr-private-apps#972': [
    '<!-- verdict sha=fc921b0 -->',
    '[tech-lead-reviewer]',
    'ESCALATE TO A HUMAN | This is the third review round on this PR.',
  ].join('\n'),
};

describe('a bare escalation (no VERDICT:) is a ruling', () => {
  for (const [source, body] of Object.entries(REAL_ESCALATIONS)) {
    it(`${source}: reads as ESCALATE`, () => {
      expect(TECH_LEAD_VERDICT_FORM_RE.test(body)).toBe(true);
      expect(parseAnchoredVerdictRuling(body)).toBe('ESCALATE');
    });

    it(`${source}: is an unactionable ruling a merge gate fails closed on`, () => {
      expect(isUnactionableRuling(body)).toBe(true);
    });

    it(`${source}: still never authorizes a merge, and is not refused at post time`, () => {
      expect(parseTechLeadVerdict(body)).toBeNull();
      expect(isMalformedVerdictPost(body)).toBe(false);
    });
  }

  it('accepts the same line on one line with the prefix, and with emphasis', () => {
    expect(parseAnchoredVerdictRuling('<!-- verdict sha=abc1234 -->\n[tech-lead-reviewer] ESCALATE TO A HUMAN | reason')).toBe('ESCALATE');
    expect(parseAnchoredVerdictRuling('<!-- verdict sha=abc1234 -->\n**[tech-lead-reviewer]**\n**ESCALATE TO A HUMAN** | reason')).toBe('ESCALATE');
  });
});

describe('the bare form is admitted for ESCALATE only, and only at the top', () => {
  it('a bare APPROVE or REQUEST_CHANGES without VERDICT: stays unparsed (nothing new can authorize a merge)', () => {
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer]\nAPPROVE | looks good')).toBeNull();
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer]\nREQUEST_CHANGES | fix it')).toBeNull();
    expect(parseTechLeadVerdict('[tech-lead-reviewer]\nAPPROVE | looks good')).toBeNull();
  });

  it('the word ESCALATE alone, or in prose after the prefix, is not a ruling', () => {
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer]\nEscalated this to the coordinator, details below.')).toBeNull();
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer] consult: I would ESCALATE TO A HUMAN if round 3 fails.')).toBeNull();
  });

  it('a note that quotes an escalation mid-body is not one', () => {
    const fixerNote = '[dev-fixer specialist] STATUS NOTE | the reviewer wrote `[tech-lead-reviewer] ESCALATE TO A HUMAN | ...` on the previous head.';
    expect(parseAnchoredVerdictRuling(fixerNote)).toBeNull();
    expect(isUnactionableRuling(fixerNote)).toBe(false);
  });

  it('leaves the VERDICT: forms exactly as they were', () => {
    expect(parseAnchoredVerdictRuling('<!-- verdict sha=63daa40 -->\n[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | Reaffirmed.')).toBe('ESCALATE');
    expect(parseAnchoredVerdictRuling('<!-- verdict sha=dc2ae3b -->\n[tech-lead-reviewer] VERDICT: APPROVE | ok')).toBe('APPROVE');
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer] VERDICT: REQUEST CHANGES | fix')).toBe('REQUEST_CHANGES');
  });
});

// #146 review note: isUnactionableRuling was FORM-match AND
// parseTechLeadVerdict === null, and parseTechLeadVerdict is unanchored. An
// escalation that quotes an older approve further down its own body therefore
// read as NOT unactionable, so a gate built on isUnactionableRuling let it pass
// when it followed an approve on the same head. The github app's gate already
// read parseAnchoredVerdictRuling === 'ESCALATE' to avoid this.
describe('an escalation that quotes an older APPROVE is still unactionable', () => {
  const quotedApprove = '`[tech-lead-reviewer] VERDICT: APPROVE | looks right`';
  const bodies: Record<string, string> = {
    'bare form': `<!-- verdict sha=abc1234 -->\n[tech-lead-reviewer]\nESCALATE TO A HUMAN | Third round. My earlier ${quotedApprove} on the previous head no longer stands.`,
    'VERDICT: form': `<!-- verdict sha=abc1234 -->\n[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | supersedes my earlier ${quotedApprove} note.`,
  };
  for (const [form, body] of Object.entries(bodies)) {
    it(`${form}: reads as ESCALATE and is unactionable, never as an APPROVE`, () => {
      expect(parseAnchoredVerdictRuling(body)).toBe('ESCALATE');
      expect(isUnactionableRuling(body)).toBe(true);
    });
  }

  it('a real APPROVE or REQUEST_CHANGES is still actionable, and a note quoting an escalation is still not one', () => {
    expect(isUnactionableRuling('<!-- verdict sha=abc1234 -->\n[tech-lead-reviewer] VERDICT: APPROVE | ok')).toBe(false);
    expect(isUnactionableRuling('[tech-lead-reviewer] VERDICT: REQUEST_CHANGES | fix it, unlike the `[tech-lead-reviewer] VERDICT: ESCALATE` I nearly posted')).toBe(false);
    expect(isUnactionableRuling('[dev-fixer specialist] STATUS NOTE | the reviewer wrote `[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN` last round.')).toBe(false);
  });
});

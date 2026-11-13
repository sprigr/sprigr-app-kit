import { describe, expect, it } from 'vitest';
import {
  TECH_LEAD_VERDICT_FORM_RE,
  TECH_LEAD_VERDICT_RE,
  isMalformedVerdictPost,
  isUnparsedVerdictShaped,
  parseAnchoredVerdictRuling,
  parseTechLeadVerdict,
  wouldPostInvisibleVerdict,
} from '../src/index';

// A lane reviewer (decision 0296) posted its verdict under its own display
// tag instead of the shared `[tech-lead-reviewer]` one. The header is verbatim
// from sprigr-apps#4830 (comment 6729301530); the reason is trimmed. That
// comment posted with no refusal and the merge gate then said "no verdict",
// blocking a real APPROVE (sprigr-team#14736).
const LANE_TAGGED_4830 = [
  '[tech-lead-reviewer-apps]',
  '<!-- verdict sha=c39fdf5 -->',
  'VERDICT: APPROVE | (apps) Follow-on audit fix for #4828.',
].join('\n');

const laneTagged = (tag: string) => LANE_TAGGED_4830.replace('[tech-lead-reviewer-apps]', `[${tag}]`);

describe('a lane-tagged verdict is refused at post time, never authorizes (#14736)', () => {
  for (const tag of ['tech-lead-reviewer-apps', 'tech-lead-reviewer-misc', 'tech-lead-reviewer-sessions']) {
    it(`[${tag}] is refused as an invisible verdict and counted as unparsed, not read as a ruling`, () => {
      const body = laneTagged(tag);
      expect(wouldPostInvisibleVerdict(body)).toBe(true);
      expect(isUnparsedVerdictShaped(body)).toBe(true);
      expect(parseAnchoredVerdictRuling(body)).toBeNull();
      expect(parseTechLeadVerdict(body)).toBeNull();
      expect(TECH_LEAD_VERDICT_FORM_RE.test(body)).toBe(false);
      expect(TECH_LEAD_VERDICT_RE.test(body)).toBe(false);
    });
  }

  it('a lane tag with the marker first and VERDICT on the tag line is refused too', () => {
    const body = '<!-- verdict sha=c39fdf5 -->\n[tech-lead-reviewer-sessions] VERDICT: APPROVE | (sessions) ok';
    expect(isMalformedVerdictPost(body)).toBe(true);
    expect(wouldPostInvisibleVerdict(body)).toBe(true);
    expect(parseAnchoredVerdictRuling(body)).toBeNull();
  });

  it('a suffix outside the list is not recognised as a reviewer comment at all', () => {
    const body = laneTagged('tech-lead-reviewer-foo');
    expect(wouldPostInvisibleVerdict(body)).toBe(false);
    expect(isUnparsedVerdictShaped(body)).toBe(false);
  });

  it('the shared tag in the same shape still parses and posts', () => {
    const body = '<!-- verdict sha=c39fdf5 -->\n[tech-lead-reviewer]\nVERDICT: APPROVE | (apps) Follow-on audit fix for #4828.';
    expect(parseAnchoredVerdictRuling(body)).toBe('APPROVE');
    expect(wouldPostInvisibleVerdict(body)).toBe(false);
    expect(isUnparsedVerdictShaped(body)).toBe(false);
  });

  it('a lane-tagged consult with no VERDICT line and no marker still posts', () => {
    const body = '[tech-lead-reviewer-misc]\nLooked at the retry path; no ruling yet, waiting on CI.';
    expect(isMalformedVerdictPost(body)).toBe(false);
    expect(wouldPostInvisibleVerdict(body)).toBe(false);
  });
});

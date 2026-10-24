import { describe, expect, it } from 'vitest';
import {
  INVISIBLE_VERDICT_ERROR,
  isMalformedVerdictPost,
  parseAnchoredVerdictRuling,
  wouldPostInvisibleVerdict,
} from '../src/index';
// Real comment bodies, fetched verbatim with `gh api repos/<repo>/issues/comments/<id>`
// (stored ASCII-escaped). See sprigr-team#12926 for the diagnosis that cites them.
import fixtures from './fixtures/verdict-guard-real-bodies.json';

const real = fixtures as Record<string, { repo: string; comment_id: number; body: string }>;
const body = (key: string): string => {
  const f = real[key];
  if (!f) throw new Error(`missing fixture ${key}`);
  return f.body;
};

// sprigr-team#12926: the Tech Lead posted two identical verdicts on one head.
// The first was a long-form review the guard let through and the anchored
// reader could not see; the second was the canonical repost.
describe('wouldPostInvisibleVerdict: the four real bodies of sprigr-team#12926', () => {
  it('REFUSES platform#148 comment 6334650810 (tag BEFORE the marker, VERDICT at offset 3271)', () => {
    const b = body('platform148_6334650810_tagBeforeMarker');
    expect(parseAnchoredVerdictRuling(b)).toBeNull();
    expect(wouldPostInvisibleVerdict(b)).toBe(true);
  });

  it('REFUSES platform#157 comment 6358629806 (prose between tag and VERDICT, offset 2467)', () => {
    const b = body('platform157_6358629806_proseBeforeVerdict');
    expect(parseAnchoredVerdictRuling(b)).toBeNull();
    expect(wouldPostInvisibleVerdict(b)).toBe(true);
  });

  it('PASSES the canonical reposts 6334667937 and 6358839810', () => {
    for (const key of ['platform148_6334667937_canonicalRepost', 'platform157_6358839810_canonicalRepost']) {
      expect(parseAnchoredVerdictRuling(body(key))).toBe('APPROVE');
      expect(wouldPostInvisibleVerdict(body(key))).toBe(false);
    }
  });

  it('pins the gap it closes: the old 800-char guard admitted both first comments', () => {
    // Not a test of new behaviour: isMalformedVerdictPost is unchanged and
    // stays exported. This records why the consumers must switch.
    expect(isMalformedVerdictPost(body('platform148_6334650810_tagBeforeMarker'))).toBe(false);
    expect(isMalformedVerdictPost(body('platform157_6358629806_proseBeforeVerdict'))).toBe(false);
  });
});

describe('wouldPostInvisibleVerdict: must not regress', () => {
  it('an explicit repost on request still passes (#12724, after request comment 6380895177)', () => {
    // The first verdict on 8ab4c9c was the same long-form shape and is now
    // refused at post time; the requested canonical repost is admitted, and
    // the SHA dedupe (consumer side, unchanged) decides from there.
    expect(wouldPostInvisibleVerdict(body('team12724_6364434741_tagBeforeMarker'))).toBe(true);
    expect(wouldPostInvisibleVerdict(body('team12724_6380906667_requestedRepost'))).toBe(false);
  });

  it('admits every canonical ruling, so RC then APPROVE and RC then a new-head re-review still reach the dedupe', () => {
    const rc = '<!-- verdict sha=d1608e3 -->\n[tech-lead-reviewer] VERDICT: REQUEST_CHANGES | the wrapper is missing';
    const approveSameHead = '<!-- verdict sha=d1608e3 -->\n[tech-lead-reviewer] VERDICT: APPROVE | wrapper added, CI green';
    const approveNewHead = '<!-- verdict sha=703bf4c -->\n[tech-lead-reviewer] VERDICT: APPROVE | delta reviewed';
    const bolded = '<!-- verdict sha=dc2ae3b -->\n[tech-lead-reviewer]\n\n**VERDICT: APPROVE** | receipts verified';
    const spaced = '[tech-lead-reviewer] VERDICT: REQUEST CHANGES | one-character variant (#7653)';
    for (const b of [rc, approveSameHead, approveNewHead, bolded, spaced]) {
      expect(wouldPostInvisibleVerdict(b)).toBe(false);
    }
  });

  it('admits a canonical ESCALATE, with or without the marker', () => {
    expect(wouldPostInvisibleVerdict('<!-- verdict sha=63daa40 -->\n[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | reaffirmed')).toBe(false);
    expect(wouldPostInvisibleVerdict('[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | needs a product call')).toBe(false);
  });

  it('passes a marker-less reviewer consult that states no ruling', () => {
    const note = '[tech-lead-reviewer] Post-merge note (not a verdict).\n\nThis PR merged before my review landed.';
    expect(wouldPostInvisibleVerdict(note)).toBe(false);
  });

  it('passes the #6367 false-block body, which quotes a marker in backticks mid-body (comment 5429229662)', () => {
    expect(wouldPostInvisibleVerdict(body('team6344_5429229662_consultQuotingMarker'))).toBe(false);
  });

  it('passes a real consult whose prose says "my verdict:" mid-sentence (comment 6116272155)', () => {
    expect(wouldPostInvisibleVerdict(body('apps3254_6116272155_consultNote'))).toBe(false);
  });

  it('passes a note that is not the reviewer speaking, whatever verdict it quotes (#6484)', () => {
    const fixerNote = '[dev-fixer specialist] STATUS NOTE: the reviewer left `[tech-lead-reviewer] VERDICT: APPROVE` '
      + 'on the earlier head.\n\nVERDICT: APPROVE was on 52d0cae.';
    expect(wouldPostInvisibleVerdict(fixerNote)).toBe(false);
  });

  it('passes a reviewer note that quotes a verdict or a marker only inside code', () => {
    const fenced = '[tech-lead-reviewer] Consult: my standing verdict reads\n\n```\n<!-- verdict sha=abc1234 -->\n'
      + '[tech-lead-reviewer] VERDICT: APPROVE | ok\n```\n\nNothing re-reviewed.';
    const doubleTick = '[tech-lead-reviewer] Note: the gate writes ``<!-- verdict sha=${headSha.slice(0, 7)} -->\\n``.';
    expect(wouldPostInvisibleVerdict(fenced)).toBe(false);
    expect(wouldPostInvisibleVerdict(doubleTick)).toBe(false);
  });
});

describe('wouldPostInvisibleVerdict: the shapes it refuses', () => {
  it('refuses the tag before the marker even when VERDICT follows directly', () => {
    expect(wouldPostInvisibleVerdict('[tech-lead-reviewer]\n<!-- verdict sha=ada4230 -->\nVERDICT: APPROVE | ok')).toBe(true);
  });

  it('refuses a long-form REQUEST_CHANGES with no marker, VERDICT far past any window', () => {
    const longForm = '[tech-lead-reviewer] Reviewed on pr.opened\n\n' + 'Finding. '.repeat(1000) + '\n\n**VERDICT: REQUEST_CHANGES** | blockers above';
    expect(longForm.indexOf('VERDICT:')).toBeGreaterThan(8000);
    expect(wouldPostInvisibleVerdict(longForm)).toBe(true);
  });

  it('refuses a marker-bearing ESCALATE that skipped the VERDICT: token (observed shape)', () => {
    expect(wouldPostInvisibleVerdict('<!-- verdict sha=c307b07 -->\n[tech-lead-reviewer]\nESCALATE TO A HUMAN | stands')).toBe(true);
  });

  it('refuses a marker on a body that is not in verdict form at all', () => {
    expect(wouldPostInvisibleVerdict('<!-- verdict sha=abc1234 -->\n[tech-lead-reviewer] consult note')).toBe(true);
  });

  it('refuses a heading between tag and VERDICT, as isMalformedVerdictPost already did', () => {
    expect(wouldPostInvisibleVerdict('## [tech-lead-reviewer] Re-review of PR #6173\n\n**VERDICT: REQUEST_CHANGES** | blocker')).toBe(true);
  });
});

describe('INVISIBLE_VERDICT_ERROR', () => {
  it('tells the reviewer exactly where the verdict line goes', () => {
    expect(INVISIBLE_VERDICT_ERROR).toContain('IMMEDIATELY after the marker');
    expect(INVISIBLE_VERDICT_ERROR).toContain('[tech-lead-reviewer] VERDICT: APPROVE | <one-line reason>');
    expect(INVISIBLE_VERDICT_ERROR).toContain('BEFORE the marker');
    expect(INVISIBLE_VERDICT_ERROR).toContain('nothing was posted');
  });
});

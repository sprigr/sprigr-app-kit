import { describe, expect, it } from 'vitest';
import {
  TECH_LEAD_VERDICT_RE,
  isUnactionableRuling,
  TECH_LEAD_VERDICT_FORM_RE,
  VERDICT_MARKER_RE,
  VERDICT_MARKER_STRIP_RE,
  parseTechLeadVerdict,
  parseAnchoredVerdictRuling,
  normalizeVerdictRuling,
  isMalformedVerdictPost,
  isUnparsedVerdictShaped,
} from '../src/index';

// #6334: comment 5423054045 — a genuine APPROVE both consumers went blind to.
// Structure verbatim from the live comment body.
const BOLDED_APPROVE = [
  '<!-- verdict sha=dc2ae3b -->',
  '[tech-lead-reviewer]',
  '',
  '**VERDICT: APPROVE** | All three receipt corrections verified against the live PR body; head SHA unchanged.',
].join('\n');

const PLAIN_APPROVE = '<!-- verdict sha=dc2ae3b -->\n[tech-lead-reviewer] VERDICT: APPROVE | Re-post in machine-readable form.';
const PLAIN_REQUEST_CHANGES = '[tech-lead-reviewer] VERDICT: REQUEST_CHANGES | fix the thing';
const PLAIN_ESCALATE = '<!-- verdict sha=63daa40 -->\n[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | Reaffirmed on a new head.';
// Real reviewer habit that stays unparseable by design: heading prose between
// the prefix and the VERDICT line.
const HEADERED_VERDICT = '## [tech-lead-reviewer] Re-review — PR #6173 @ `c72280b`\n\n**VERDICT: REQUEST_CHANGES** | blocker';

describe('TECH_LEAD_VERDICT_RE (#6334)', () => {
  it('parses the markdown-bolded APPROVE that both consumers went blind to', () => {
    expect(parseTechLeadVerdict(BOLDED_APPROVE)).toBe('APPROVE');
    expect(TECH_LEAD_VERDICT_RE.test(BOLDED_APPROVE)).toBe(true);
  });

  it('still parses the plain machine form and REQUEST_CHANGES', () => {
    expect(parseTechLeadVerdict(PLAIN_APPROVE)).toBe('APPROVE');
    expect(parseTechLeadVerdict(PLAIN_REQUEST_CHANGES)).toBe('REQUEST_CHANGES');
  });

  it('parses underscore emphasis and bold around the ruling word', () => {
    expect(parseTechLeadVerdict('[tech-lead-reviewer] _VERDICT: APPROVE_')).toBe('APPROVE');
    expect(parseTechLeadVerdict('[tech-lead-reviewer] VERDICT: **APPROVE**')).toBe('APPROVE');
  });

  it('does not parse an ESCALATE ruling as a merge-actionable verdict', () => {
    expect(parseTechLeadVerdict(PLAIN_ESCALATE)).toBeNull();
  });

  it('does not parse a verdict separated from the prefix by heading prose', () => {
    expect(parseTechLeadVerdict(HEADERED_VERDICT)).toBeNull();
  });
});

describe('isUnparsedVerdictShaped', () => {
  it('flags the headered verdict and the ESCALATE ruling as verdict-shaped-but-unparsed', () => {
    expect(isUnparsedVerdictShaped(HEADERED_VERDICT)).toBe(true);
    expect(isUnparsedVerdictShaped(PLAIN_ESCALATE)).toBe(true);
  });

  it('does not flag parseable verdicts or ordinary fixer comments', () => {
    expect(isUnparsedVerdictShaped(BOLDED_APPROVE)).toBe(false);
    expect(isUnparsedVerdictShaped(PLAIN_APPROVE)).toBe(false);
    expect(isUnparsedVerdictShaped('[dev-fixer-b] requesting review | receipt corrected')).toBe(false);
  });
});

describe('isUnactionableRuling (#6367 round 2: the only shape a gate may fail closed on)', () => {
  it('true only for a machine-form ruling the gate cannot act on', () => {
    expect(isUnactionableRuling(PLAIN_ESCALATE)).toBe(true);
    expect(isUnactionableRuling(PLAIN_APPROVE)).toBe(false);
    expect(isUnactionableRuling(HEADERED_VERDICT)).toBe(false);
    // A reviewer note that merely says the word "verdict" is prose, not a ruling.
    expect(isUnactionableRuling('[tech-lead-reviewer] Consult answer, NOT a new verdict. My APPROVE stands.')).toBe(false);
  });
});

describe('TECH_LEAD_VERDICT_FORM_RE / VERDICT_MARKER_RE (post-time validation inputs)', () => {
  it('accepts all three plain-form rulings including ESCALATE', () => {
    expect(TECH_LEAD_VERDICT_FORM_RE.test(PLAIN_APPROVE)).toBe(true);
    expect(TECH_LEAD_VERDICT_FORM_RE.test(PLAIN_REQUEST_CHANGES)).toBe(true);
    expect(TECH_LEAD_VERDICT_FORM_RE.test(PLAIN_ESCALATE)).toBe(true);
  });

  it('rejects the headered form, and the marker regex identifies machine artifacts', () => {
    expect(TECH_LEAD_VERDICT_FORM_RE.test(HEADERED_VERDICT)).toBe(false);
    expect(VERDICT_MARKER_RE.test(BOLDED_APPROVE)).toBe(true);
    expect(VERDICT_MARKER_RE.test(PLAIN_REQUEST_CHANGES)).toBe(false);
  });
});

describe('TECH_LEAD_VERDICT_FORM_RE anchoring (#6484)', () => {
  // Real proof case: comment 5454053747 on #6470
  // (https://github.com/sprigr/sprigr-team/pull/6470#issuecomment-5454053747).
  // A `[dev-fixer specialist]` STATUS NOTE, not a reviewer verdict, that
  // recaps the PR's comment trail and in doing so quotes
  // `` `[tech-lead-reviewer] VERDICT: APPROVE` `` mid-sentence. Verbatim
  // excerpt from the live comment body.
  const STATUS_NOTE_QUOTING_A_VERDICT = [
    '[dev-fixer specialist] Round-2 revision check — already completed, no action taken.',
    '',
    'On checkout, PR #6470 was already `MERGED` (mergedAt `2026-08-28T14:27:25Z`, squash commit ' +
      '`a547b193` on `staging`) — landed by a concurrent run of this same revision task while I was ' +
      'still setting up my environment.',
    '',
    'Confirmed via the PR\'s own comment trail: `[dev-fixer] requesting review` (14:22:04Z) reports the ' +
      'same one-line change plus a plain merge of `origin/staging` (4 commits, no conflicts) done first; ' +
      '`[tech-lead-reviewer] VERDICT: APPROVE` (14:26:30Z, verdict sha=e98859e) independently re-verified ' +
      'the line in source, confirmed CI green.',
  ].join('\n');

  it('does not match a status note that only QUOTES a verdict mid-body', () => {
    expect(TECH_LEAD_VERDICT_FORM_RE.test(STATUS_NOTE_QUOTING_A_VERDICT)).toBe(false);
    expect(isUnactionableRuling(STATUS_NOTE_QUOTING_A_VERDICT)).toBe(false);
  });

  it('still matches a leading machine marker or heading ahead of the identity prefix', () => {
    expect(TECH_LEAD_VERDICT_FORM_RE.test(PLAIN_APPROVE)).toBe(true); // marker, then prefix
    expect(TECH_LEAD_VERDICT_FORM_RE.test('[tech-lead-reviewer] VERDICT: APPROVE')).toBe(true); // bare prefix
  });
});

describe('TECH_LEAD_VERDICT_FORM_RE round 2 (#6484): leading emphasis on the identity prefix', () => {
  // Real proof case: comments 5451246349 (10:09:15Z) and 5451314888
  // (10:16:41Z) on #6456, both `<!-- verdict sha=69acb41 -->\n**[tech-lead-reviewer]
  // VERDICT: …**`. The round-1 anchor admitted a leading marker/heading but
  // not leading `**`/`_` emphasis directly on `[tech-lead-reviewer]`, so both
  // real verdicts — an APPROVE and a superseding REQUEST_CHANGES — fell out
  // of the form entirely: `applyVerdictCiGate` passed them through with no CI
  // gate and no marker re-derive, and `isUnactionableRuling` stopped treating
  // a bolded ESCALATE as a ruling the merge gate must fail closed on.
  // Verbatim excerpts from the live comment bodies.
  const BOLDED_PREFIX_APPROVE_6456 = [
    '<!-- verdict sha=69acb41 -->',
    '**[tech-lead-reviewer] VERDICT: APPROVE**',
    '',
    'Reviewed from the artifacts (PR metadata, full diff, workflow runs, issue #6412), treating the review receipt as a map and re-testing each Assumption against the head-branch source at `69acb41`.',
  ].join('\n');

  const BOLDED_PREFIX_REQUEST_CHANGES_6456 = [
    '<!-- verdict sha=69acb41 -->',
    '**[tech-lead-reviewer] VERDICT: REQUEST_CHANGES | red core CI job `ratchet` on head `69acb41` | no code change is requested on this branch: this is blocked on the `packages/agent-core/src/tools/github.ts` split tracked in #6457, and `needs-human` is applied for the split-first vs merge-then-split sequencing call.**',
    '',
    'This SUPERSEDES my APPROVE (comment 5451246349) on th',
  ].join('\n');

  it('parses a marker-carrying verdict whose identity prefix itself is bolded', () => {
    expect(TECH_LEAD_VERDICT_FORM_RE.test(BOLDED_PREFIX_APPROVE_6456)).toBe(true);
    expect(TECH_LEAD_VERDICT_FORM_RE.exec(BOLDED_PREFIX_APPROVE_6456)?.[1].toUpperCase()).toBe('APPROVE');
    expect(TECH_LEAD_VERDICT_FORM_RE.test(BOLDED_PREFIX_REQUEST_CHANGES_6456)).toBe(true);
    expect(TECH_LEAD_VERDICT_FORM_RE.exec(BOLDED_PREFIX_REQUEST_CHANGES_6456)?.[1].toUpperCase()).toBe('REQUEST_CHANGES');
  });

  it('still fails closed: a bolded-prefix ESCALATE is an unactionable ruling the merge gate must not let bypass', () => {
    const boldedEscalate = '<!-- verdict sha=69acb41 -->\n**[tech-lead-reviewer] VERDICT: ESCALATE TO A HUMAN | reaffirmed**';
    expect(isUnactionableRuling(boldedEscalate)).toBe(true);
  });

  it('still rejects the #6470 status note that only quotes a verdict, and the headered-prose case, after the widen', () => {
    const STATUS_NOTE_QUOTING_A_VERDICT = [
      '[dev-fixer specialist] Round-2 revision check — already completed, no action taken.',
      '',
      'Confirmed via the PR\'s own comment trail: ' +
        '`[tech-lead-reviewer] VERDICT: APPROVE` (14:26:30Z, verdict sha=e98859e) independently re-verified ' +
        'the line in source, confirmed CI green.',
    ].join('\n');
    expect(TECH_LEAD_VERDICT_FORM_RE.test(STATUS_NOTE_QUOTING_A_VERDICT)).toBe(false);
    expect(TECH_LEAD_VERDICT_FORM_RE.test(HEADERED_VERDICT)).toBe(false);
  });
});

describe('VERDICT_MARKER_STRIP_RE (#6484)', () => {
  it('strips a leading marker so a fresh one can be prepended', () => {
    expect(PLAIN_APPROVE.replace(VERDICT_MARKER_STRIP_RE, '')).toBe(
      '[tech-lead-reviewer] VERDICT: APPROVE | Re-post in machine-readable form.',
    );
  });

  it('leaves a non-leading marker untouched — it is quoted text, not the comment\'s own marker', () => {
    const quotedMarkerMidBody = '[dev-fixer] see the earlier note: <!-- verdict sha=abc1234 -->\n[tech-lead-reviewer] VERDICT: APPROVE';
    expect(quotedMarkerMidBody.replace(VERDICT_MARKER_STRIP_RE, '')).toBe(quotedMarkerMidBody);
  });
});

// ─── #7653: measured against 95 live reviewer comments over 60h ────────────
//
// Only 50 of 95 parsed. A verdict that does not parse is not merely
// mis-summarised — it is ABSENT: github-merge-gate returns ok when no verdict
// parses, so a REQUEST_CHANGES did not block a merge and an APPROVE never
// reached the CI-green check. Two distinct defects produced the 45:
//   * 19 differed by ONE character: `REQUEST CHANGES` for `REQUEST_CHANGES`.
//   * the rest put review prose between the identity prefix and VERDICT:.
// The first is folded here (a separator inside an already-anchored ruling
// token weakens nothing). The second is deliberately NOT parsed — see
// HEADERED_VERDICT above — and is refused at post time instead.
describe('#7653 — the ruling-token separator', () => {
  const SPACE_RULING = '[tech-lead-reviewer]\n\n**VERDICT: REQUEST CHANGES** — the fix is real but incomplete.';

  it('parses `REQUEST CHANGES` with a space and normalises it', () => {
    expect(parseAnchoredVerdictRuling(SPACE_RULING)).toBe('REQUEST_CHANGES');
    expect(parseTechLeadVerdict(SPACE_RULING)).toBe('REQUEST_CHANGES');
  });

  it('never emits a ruling containing a space', () => {
    // github-merge-gate puts the parsed ruling in a field typed
    // 'REQUEST_CHANGES'; a raw "REQUEST CHANGES" there makes every later
    // equality check silently false.
    expect(parseAnchoredVerdictRuling(SPACE_RULING)).not.toMatch(/ /);
    expect(normalizeVerdictRuling('request changes')).toBe('REQUEST_CHANGES');
  });

  it('leaves the canonical and ESCALATE forms exactly as they were', () => {
    expect(parseAnchoredVerdictRuling(PLAIN_REQUEST_CHANGES)).toBe('REQUEST_CHANGES');
    expect(parseAnchoredVerdictRuling(PLAIN_ESCALATE)).toBe('ESCALATE');
    expect(parseAnchoredVerdictRuling(PLAIN_APPROVE)).toBe('APPROVE');
  });

  it('does NOT make the headered form parse — that stays unparseable by design', () => {
    // Widening the prefix to admit the heading line was tried and reverted:
    // it would also match `[tech-lead-reviewer] ... superseding my earlier
    // VERDICT: APPROVE`, reading a note about a verdict as a verdict.
    expect(parseAnchoredVerdictRuling(HEADERED_VERDICT)).toBeNull();
  });
});

describe('#7653 — isMalformedVerdictPost (post-time refusal)', () => {
  it('refuses the headered form, which is how the reviewer actually writes most verdicts', () => {
    expect(isMalformedVerdictPost(HEADERED_VERDICT)).toBe(true);
  });

  it('does NOT refuse a decorated ruling that still starts with a real one', () => {
    // Pre-existing and left alone: the alternation is not word-bounded, so
    // `APPROVE WITH NITS` parses as APPROVE. That reading is right — it IS an
    // approval, and it still faces the CI-green gate. The live instances of
    // this wording in the sample were refused anyway, for the heading before
    // them, not for the ruling.
    expect(isMalformedVerdictPost('[tech-lead-reviewer] VERDICT: APPROVE WITH NITS | merge-ready')).toBe(false);
    expect(parseAnchoredVerdictRuling('[tech-lead-reviewer] VERDICT: APPROVE WITH NITS | merge-ready')).toBe('APPROVE');
    // ...but the same wording behind a heading, which is how it actually
    // appeared in the sample, IS refused.
    expect(isMalformedVerdictPost('## [tech-lead-reviewer] Review of #7494\n\n**VERDICT: APPROVE WITH NITS**')).toBe(true);
  });

  it('passes every body that parses, including ESCALATE', () => {
    for (const body of [PLAIN_APPROVE, PLAIN_REQUEST_CHANGES, PLAIN_ESCALATE]) {
      expect(isMalformedVerdictPost(body)).toBe(false);
    }
  });

  it('passes a reviewer consult note that states no ruling', () => {
    // 11 of the 39 non-parsing bodies were genuine notes. Refusing those would
    // break the reviewer's ability to comment at all.
    const note = '[tech-lead-reviewer] Post-merge note (not a verdict).\n\nThis PR merged before my review landed.';
    expect(isMalformedVerdictPost(note)).toBe(false);
  });

  it('passes a body that is not the reviewer speaking, even if it quotes a verdict', () => {
    // Why this is NOT isUnparsedVerdictShaped: that predicate is unanchored and
    // flags these, and gating on it would refuse a fixer status note.
    const fixerNote = '[dev-fixer] FIXED | PR #7520 merged. The reviewer left '
      + '`[tech-lead-reviewer] VERDICT: APPROVE` on the earlier head.';
    expect(isMalformedVerdictPost(fixerNote)).toBe(false);
  });
});

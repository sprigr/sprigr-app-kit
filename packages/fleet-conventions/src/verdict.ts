/**
 * @sprigr/apps-fleet-conventions: tech-lead-reviewer verdict conventions.
 *
 * Ported byte-for-byte (apart from this header) from sprigr-team
 * `packages/shared/src/utils/fleet-verdict.ts`, followed by `verdictNamedSha`
 * and its pattern table from `packages/agent-core/src/tools/github-merge-gate.ts`,
 * so the platform (`@sprigr/team-shared`) and the github marketplace app share
 * one implementation instead of two hand-synced copies. The file paths named
 * in the doc comments below point into sprigr-team, where the consumers live.
 */

/**
 * The single source of truth for parsing tech-lead-reviewer verdict comments.
 *
 * Two consumers gate real behaviour on this pattern: the merge gate in
 * packages/agent-core/src/tools/github-merge-gate.ts (`assertApprovalIsCurrent`) and the
 * fleet event router in workers/provisioning/src/github-event-router.ts
 * (verdict-posted wakes). They previously carried two hand-synced copies of
 * the regex; both were blind to markdown emphasis, and both failed together
 * on the same comment (#6334).
 *
 * History (#6334): the reviewer posted a genuine APPROVE written as
 * `[tech-lead-reviewer]\n\n**VERDICT: APPROVE**`. The old
 * `\[tech-lead-reviewer\]\s*VERDICT:` pattern matched the newlines but not
 * the `**`, so the merge gate reported the older REQUEST_CHANGES as "most
 * recent" and the router never fired a wake — a message that read exactly
 * like a stale/forged-verdict attack and manufactured a critical-severity
 * security escalation. No forgery occurred; the parser could not survive
 * bold. The fix is parser tolerance, not dropping the machine format:
 * `[\s*_]*` admits whitespace/newlines plus `*`/`_` emphasis markers between
 * the identity prefix, `VERDICT:`, and the ruling word.
 */
export const TECH_LEAD_VERDICT_RE = /\[tech-lead-reviewer\][\s*_]*VERDICT:[\s*_]*(APPROVE|REQUEST[_ ]CHANGES)/i;

/**
 * The canonical machine marker the reviewer persona puts on the first line of
 * every verdict (`<!-- verdict sha=<7-char head SHA> -->`). Comments carrying
 * it are machine artifacts by contract, which is what makes post-time
 * validation of them safe: prose that merely QUOTES a verdict never carries
 * the marker.
 */
export const VERDICT_MARKER_RE = /<!--\s*verdict\s+sha=/i;

/**
 * Strips a LEADING machine marker so a fresh one can be prepended in its
 * place (`add_pull_request_comment`'s unconditional re-derive, #6482).
 * Anchored to the start of the body on purpose: a marker that shows up
 * later in the body — e.g. inside quoted prose from an earlier comment — is
 * not "the" marker and must never be touched. Exported so every caller that
 * needs to replace a marker uses this one definition instead of a hand-rolled
 * copy that could drift out of anchor.
 */
export const VERDICT_MARKER_STRIP_RE = /^\s*<!--\s*verdict\s+sha=[^>]*-->\s*\n?/i;

/** Loose "this comment is trying to be a reviewer verdict" detector: the
 *  reviewer's prefix plus the word VERDICT, in any formatting. Used only to
 *  COUNT verdict-shaped comments the strict pattern could not parse — never
 *  to authorize anything. */
const VERDICT_SHAPED_RE = /\[tech-lead-reviewer\][\s\S]{0,80}?VERDICT/i;

/**
 * Post-time form check: like TECH_LEAD_VERDICT_RE but also admitting the
 * ESCALATE ruling, which is a legitimate verdict for humans that the merge
 * gate deliberately cannot act on. Used to validate a verdict body BEFORE
 * posting; never used to authorize a merge.
 *
 * Anchored to the START of the body (#6484): an unanchored version matched
 * `[tech-lead-reviewer] VERDICT: <ruling>` anywhere in the text, including
 * prose that only QUOTES a verdict rather than stating one. Real proof case:
 * comment 5454053747 on #6470 is a `[dev-fixer specialist]` STATUS NOTE whose
 * body opens with that prefix, not `[tech-lead-reviewer]`, but quotes
 * `` `[tech-lead-reviewer] VERDICT: APPROVE` `` mid-sentence while recapping
 * the PR's comment trail — the unanchored pattern matched that quote and
 * would have routed the note through the CI-gate/marker-attach path in
 * `add_pull_request_comment` as if it were a real verdict. The allowed prefix
 * is `(optional machine marker)(optional markdown heading)(optional leading
 * emphasis)[tech-lead-reviewer]` — the marker and heading are real, observed
 * reviewer habits that still precede the identity prefix at the true start of
 * a body (see `VERDICT_MARKER_STRIP_RE` and the `HEADERED_VERDICT` fixture
 * below); prose between `[tech-lead-reviewer]` and `VERDICT:` itself still
 * fails to parse, unchanged from before.
 *
 * Round 2 (#6484): the first anchored cut above admitted the marker and the
 * heading but not leading `**`/`_` emphasis directly on the identity prefix,
 * which is a live reviewer habit and not a hypothetical — comments
 * `5451246349` and `5451314888` on #6456 both open
 * `<!-- verdict sha=69acb41 -->\n**[tech-lead-reviewer] VERDICT: …**` and fell
 * out of the anchored form entirely. That silently re-opened the #6334 hole
 * this pattern exists to close: `applyVerdictCiGate` passed the bolded body
 * through untouched (no CI gate, no marker re-derive), and separately
 * `isUnactionableRuling` stopped recognizing a bolded ESCALATE as a ruling the
 * merge gate must fail closed on. `[*_]*` ahead of the prefix admits the
 * emphasis the same way `[\s*_]*` already does between the prefix and
 * `VERDICT:`, without loosening the anchor itself.
 */
export const TECH_LEAD_VERDICT_FORM_RE = /^(?:<!--\s*verdict\s+sha=[^>]*-->\s*\n?)?\s*(?:#{1,6}\s*)?[*_]*\[tech-lead-reviewer\][\s*_]*VERDICT:[\s*_]*(APPROVE|REQUEST[_ ]CHANGES|ESCALATE)/i;

export type TechLeadVerdict = 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Fold a captured ruling to its canonical spelling.
 *
 * Both patterns admit `REQUEST CHANGES` with a SPACE as well as the canonical
 * `REQUEST_CHANGES`, so every capture must come through here before it is used
 * or compared — `github-merge-gate.ts` casts the raw capture straight to the
 * union type, which would otherwise put the literal string "REQUEST CHANGES"
 * into a field typed `'REQUEST_CHANGES'` and make every later equality check
 * silently false.
 *
 * Why admit the space at all rather than refusing it (#7653): measured over
 * 60 h, 19 of 39 non-parsing reviewer comments differed from the contract by
 * exactly this one character. It is unambiguous — no other ruling it could
 * mean — and every consumer treats the two identically, so folding it is
 * strictly safer than leaving those verdicts INVISIBLE to the merge gate,
 * which is what the strict spelling was actually achieving. The canonical form
 * stays `REQUEST_CHANGES` (scripts/seed-fleet-agents.ts) and is what every
 * consumer sees; this only stops a separator from voiding a real ruling.
 */
export function normalizeVerdictRuling(raw: string): TechLeadRuling {
  return raw.toUpperCase().replace(/\s+/g, '_') as TechLeadRuling;
}

export type TechLeadRuling = 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE';

/**
 * Parse a comment body's ruling using the ANCHORED TECH_LEAD_VERDICT_FORM_RE
 * pattern (admits ESCALATE), never the unanchored TECH_LEAD_VERDICT_RE.
 *
 * #6584 round 2: the duplicate-verdict backstop in
 * packages/agent-core/src/tools/github.ts originally read both sides of the
 * comparison with parseTechLeadVerdict (unanchored, APPROVE|REQUEST_CHANGES
 * only). An ESCALATE comment that QUOTES the verdict it supersedes — e.g.
 * "...supersedes my earlier `[tech-lead-reviewer] VERDICT: APPROVE` note" —
 * has no APPROVE or REQUEST_CHANGES at the true start of its body, but the
 * unanchored reader matched the quoted text anywhere in the string and
 * reported the whole comment as APPROVE. That misclassified a non-terminal
 * ESCALATE as the terminal ruling, which refused every later verdict on that
 * head — reproducing the exact #6584 deadlock inside the escalation lane.
 * This reader is anchored to the start of the body (same anchor as
 * TECH_LEAD_VERDICT_FORM_RE itself), so a quote appearing later can never be
 * mistaken for the comment's own ruling.
 */
export function parseAnchoredVerdictRuling(body: string): TechLeadRuling | null {
  const m = body.match(TECH_LEAD_VERDICT_FORM_RE);
  return m ? normalizeVerdictRuling(m[1]) : null;
}

/** Parse a comment body into a verdict, or null if none parses. */
export function parseTechLeadVerdict(body: string): TechLeadVerdict | null {
  const m = body.match(TECH_LEAD_VERDICT_RE);
  return m ? (normalizeVerdictRuling(m[1]) as TechLeadVerdict) : null;
}

/**
 * True when a body looks like a reviewer verdict but the strict pattern
 * cannot parse a ruling out of it. COUNT-ONLY: built for reporting ("N
 * comments look like verdicts but did not parse"), never for blocking or
 * authorizing — the loose shape matches any reviewer note that merely says
 * the word "verdict", and using it to block parked an already-approved PR in
 * the #6367 round-2 measurement: 80 real comments replayed across 8 PRs,
 * 2 blocked, 1 falsely (comment 5429229662 on #6344, a consult note posted
 * after its own APPROVE). Source: the round-2 verdict on PR #6367, which
 * records the PR list and per-comment results.
 * A gate that finds any of these MUST say so in its output instead of
 * reporting the newest PARSEABLE verdict as "the most recent verdict" —
 * stating more than it measured is what escalated #6334 from a formatting
 * bug to a security incident.
 */
export function isUnparsedVerdictShaped(body: string): boolean {
  return VERDICT_SHAPED_RE.test(body) && parseTechLeadVerdict(body) === null;
}

/**
 * True when a body states a machine-form `VERDICT: <ruling>` whose ruling the
 * merge gate cannot act on (today: ESCALATE TO A HUMAN). This is the ONLY
 * shape a gate may fail closed on: it is a deliberate ruling in the machine
 * format, not prose that happens to mention verdicts. Malformed rulings that
 * fail even the FORM pattern are prevented at post time instead
 * (add_pull_request_comment's marker validation).
 */
export function isUnactionableRuling(body: string): boolean {
  return TECH_LEAD_VERDICT_FORM_RE.test(body) && parseTechLeadVerdict(body) === null;
}

/** Anchored "this body opens as a reviewer comment" test. Same prefix the FORM
 *  pattern anchors on, without requiring the verdict line to follow. */
const REVIEWER_ANCHOR_RE = /^(?:<!--\s*verdict\s+sha=[^>]*-->\s*\n?)?\s*(?:#{1,6}\s*)?[*_]*\[tech-lead-reviewer\]/i;

/** How far into a body a `VERDICT:` line still counts as this comment's own
 *  ruling attempt rather than a quotation buried in prose. */
const VERDICT_STATEMENT_WINDOW = 800;

/**
 * POST-TIME ONLY: this body is trying to be a verdict and is malformed.
 *
 * True when the body opens as a reviewer comment AND states a `VERDICT:` line
 * near the top AND does not match `TECH_LEAD_VERDICT_FORM_RE`. Used by
 * `applyVerdictCiGate` to refuse the post outright, so the author learns at
 * post time instead of the verdict being silently invisible to the merge gate
 * for hours.
 *
 * NOT `isUnparsedVerdictShaped`, which its own docstring reserves for COUNTING
 * and which must never gate: that one is unanchored (so it fires on any note
 * quoting a verdict — measured, it flags four `[dev-fixer]` status notes here)
 * and it reads with `parseTechLeadVerdict`, which does not admit ESCALATE, so
 * gating on it would refuse legitimate ESCALATE verdicts. Both were measured
 * against 95 live comments before this predicate was written (#7653).
 *
 * Fail-open by construction: a reviewer note that states no `VERDICT:` at all
 * is a consult and passes untouched (11 of 39 non-parsing bodies in that
 * sample), as does anything not opening with the reviewer's own prefix.
 */
export function isMalformedVerdictPost(body: string): boolean {
  if (!REVIEWER_ANCHOR_RE.test(body)) return false;
  if (!/VERDICT:/i.test(body.slice(0, VERDICT_STATEMENT_WINDOW))) return false;
  return !TECH_LEAD_VERDICT_FORM_RE.test(body);
}

/**
 * The tech-lead-reviewer persona names the head it reviewed in every verdict
 * ("First verdict on head `<sha>`" / "Round N of 2 on head `<sha>`"). When
 * present, this is the primary freshness signal — see the SHA comparison
 * below.
 */
const VERDICT_HEAD_SHA_PATTERNS: RegExp[] = [
  // Canonical machine marker. seed-fleet-agents.ts mandates it as the FIRST
  // line of every verdict ("<!-- verdict sha=<7-char head SHA> -->") and calls
  // it "what makes your verdict idempotent - every owed-a-verdict predicate
  // keys on it". It was NOT read here, so the strong server-side comparison
  // below was skipped for template-compliant verdicts and the weak
  // committer-date fallback ran instead (#6054). Verified against four real
  // verdict bodies on PRs #6063/#6092/#6087: none matched the prose form.
  /<!--\s*verdict\s+sha=\s*`?([0-9a-f]{7,40})`?\s*-->/i,
  // Prose form, kept for verdicts that spell it out ("First verdict on head
  // `<sha>`" / "Round N of 2 on head `<sha>`").
  /\bon head\s+`?([0-9a-f]{7,40})`?/i,
];

/** The head SHA a verdict names, from whichever form it used. */
export function verdictNamedSha(body: string): string | undefined {
  for (const re of VERDICT_HEAD_SHA_PATTERNS) {
    const m = body.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return undefined;
}

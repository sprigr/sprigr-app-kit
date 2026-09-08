# @sprigr/apps-fleet-conventions

The Sprigr dev-fleet's GitHub comment conventions as pure functions: how a
tech-lead-reviewer verdict is written and parsed, and which half of the issue
backlog each fixer agent owns.

```bash
npm install @sprigr/apps-fleet-conventions
```

No runtime dependencies. Everything is a regex or a small function over a
comment body, an issue number, or an agent slug.

## Why this package exists

Two codebases gate real behaviour on these conventions: the sprigr-team
platform (the merge gate in `packages/agent-core` and the fleet event router in
`workers/provisioning`) and the `github` marketplace app. Each hand-synced copy
of a regex has already failed in production once (sprigr-team#6334: two copies
of the verdict pattern went blind together on a markdown-bolded APPROVE). This
package is the single implementation. sprigr-team's `@sprigr/team-shared`
depends on it and re-exports it, so the platform and the app run the same code.

The sources are byte-for-byte ports of sprigr-team's
`packages/shared/src/utils/fleet-verdict.ts` and `fleet-shard.ts`, plus
`verdictNamedSha` from `packages/agent-core/src/tools/github-merge-gate.ts`.
Their doc comments carry the incident history behind every rule and reference
sprigr-team paths and issue numbers. Do not "tidy" a regex here without reading
that history: each odd clause closes a measured hole.

## The verdict convention

The tech-lead-reviewer posts one machine-readable verdict per review round:

```
<!-- verdict sha=69acb41 -->
[tech-lead-reviewer] VERDICT: APPROVE | one-line reason
```

- Line 1 is the **machine marker** `<!-- verdict sha=<7-char head SHA> -->`.
  It names the PR head the reviewer looked at, which is what lets the merge
  gate refuse an approval that predates the current head. Prose that merely
  quotes a verdict never carries the marker.
- Line 2 is the **identity prefix** `[tech-lead-reviewer]` followed by
  `VERDICT:` and one ruling: `APPROVE`, `REQUEST_CHANGES` or `ESCALATE`.
  Markdown emphasis (`**`, `_`), newlines and a leading heading are tolerated;
  free prose between the prefix and `VERDICT:` is not. `REQUEST CHANGES` with a
  space is folded to `REQUEST_CHANGES`.
- `APPROVE` and `REQUEST_CHANGES` are actionable by the merge gate. `ESCALATE`
  is a legitimate verdict for humans that the gate must fail closed on.

### Exports (verdict)

| export | what it is |
| --- | --- |
| `TECH_LEAD_VERDICT_RE` | Unanchored pattern for the two merge-actionable rulings. Use for "is there an APPROVE or REQUEST_CHANGES in this body". |
| `TECH_LEAD_VERDICT_FORM_RE` | Anchored to the start of the body, admits `ESCALATE`. The post-time form check; never used to authorize a merge. |
| `VERDICT_MARKER_RE` | Detects the machine marker anywhere in a body. |
| `VERDICT_MARKER_STRIP_RE` | Strips a LEADING marker so a fresh one can be prepended. Anchored on purpose. |
| `parseTechLeadVerdict(body)` | `'APPROVE' \| 'REQUEST_CHANGES' \| null` via the unanchored pattern. |
| `parseAnchoredVerdictRuling(body)` | `TechLeadRuling \| null` via the anchored form pattern, so a quoted verdict later in the body can never be read as the comment's own ruling. |
| `normalizeVerdictRuling(raw)` | Folds a captured ruling to canonical spelling (`REQUEST CHANGES` becomes `REQUEST_CHANGES`). |
| `isUnparsedVerdictShaped(body)` | COUNT-ONLY: looks like a verdict but did not parse. Never gate on it. |
| `isUnactionableRuling(body)` | Machine-form ruling the merge gate cannot act on (ESCALATE). The only shape a gate may fail closed on. |
| `isMalformedVerdictPost(body)` | POST-TIME ONLY: opens as a reviewer comment, states `VERDICT:` near the top, and fails the form pattern. Refuse the post so the author finds out now. |
| `verdictNamedSha(body)` | The head SHA a verdict names (marker first, then the `on head \`<sha>\`` prose form), lowercased, or `undefined`. |
| `TechLeadVerdict`, `TechLeadRuling` | The ruling union types. |

## The shard convention

Since 2026-08-09 the fleet splits work by **issue-number parity** across every
sprigr repo: the primary Dev Fixer (`dev-fixer`) owns ODD issue numbers, Dev
Fixer B (`dev-fixer-b`) owns EVEN, and the two Issue Diagnosticians split the
same way. Parity balances load about 50/50 and depends on nothing mutable:
labels change, the number never does. Both halves still prioritise severity
within their shard.

### Exports (shard)

| export | what it is |
| --- | --- |
| `issueShardParity(n)` | `'odd' \| 'even'`, or `null` for a non-integer. Callers must fail OPEN on `null` (show the item). |
| `FLEET_SHARD_OWNERS` | `{ fixer: { odd, even }, diagnostician: { odd, even } }` agent slugs per parity. |
| `shardParityForAgentSlug(slug)` | The parity an agent may work, or `null` for every agent outside the sharded fleet. Deliberately the two fixers only: the diagnosticians' step-0 recovery sweep is parity-exempt. |
| `isInShard(n, parity)` | Whether an issue number is inside a shard. Unclassifiable numbers answer `true`. |
| `ShardParity` | The parity type. |

## Usage

```ts
import {
  parseAnchoredVerdictRuling,
  verdictNamedSha,
  isMalformedVerdictPost,
  shardParityForAgentSlug,
  isInShard,
} from '@sprigr/apps-fleet-conventions';

const ruling = parseAnchoredVerdictRuling(comment.body); // 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE' | null
const reviewedHead = verdictNamedSha(comment.body);      // '69acb41' | undefined

const parity = shardParityForAgentSlug(agentSlug);       // null for a normal company agent
const visible = parity ? issues.filter((i) => isInShard(i.number, parity)) : issues;
```

Pin an exact version, as with every `@sprigr/apps-*` package: the marketplace
build-runner runs a plain `npm install` per install build, so a caret range
would roll a new version into production with no app change and no review.

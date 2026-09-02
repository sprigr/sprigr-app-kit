/**
 * Write-protection types, mirrored from the Sprigr platform.
 *
 * Three tiers exist on the platform and they are not substitutes for each
 * other (sprigr-team decisions 0009, 0011, 0012):
 *
 *   T1  `confirmation` policy in the manifest. The platform enforces it BEFORE
 *       your handler is dispatched, but the MODEL sets `confirm: true`, so it
 *       is a reviewable declaration and an audit trail, not a control.
 *   T2  `_approval` envelope returned by the handler. The platform pauses the
 *       turn on a decision card; only a real human tap mints the grant. This is
 *       the only tier that actually stops a write.
 *   T3  `_undo` envelope returned beside a successful write. The platform mints
 *       the token and surfaces `undo_change`; the app keeps the before-image.
 *
 * Canonical declarations live in sprigr-team:
 *   - `AppToolConfirmRule`, `AppToolConfirmationPolicy`, `AppUndoEnvelope`:
 *     packages/shared/src/types/marketplace.ts
 *   - `AppApprovalEnvelope`: packages/agent-core/src/marketplace-tool-builder.ts
 * Keep the field sets in sync when the platform changes them. Mirrored (not
 * imported) for the same reason `MarketplaceEventSourceIntegration` is: the
 * platform packages are private and this SDK is public.
 */

/** One confirmation rule. `always`, or `when` a counted input crosses a threshold. */
export interface ConfirmRule {
  /** Gate every call. Use for permanent deletes, refunds, anything public-facing. */
  always?: boolean;
  /**
   * Gate only when a batch crosses a threshold. `count` names an input key
   * (dotted paths work; on a `{ action, input }` dispatcher it MUST be dotted
   * through `input.`); an array contributes its length, a number its own
   * value, anything else counts as nothing and never trips. Never threshold a
   * money field: a numeric STRING amount is silently no gate at all.
   */
  when?: ConfirmCondition | ConfirmCondition[];
  /**
   * What the person is asked to approve. `{key}` interpolates from the
   * top-level input. Do NOT end it in a period: the platform renders it as
   * `Action: <text>.`.
   */
  describe?: string;
  /** Appends "which cannot be undone" so the model cannot undersell it. */
  irreversible?: boolean;
}

export interface ConfirmCondition {
  count: string;
  atLeast: number;
}

/** Tool-level policy, plus per-action rules for a dispatcher tool. */
export interface ConfirmationPolicy extends ConfirmRule {
  /**
   * Per-action rules, keyed by action name (read from `dispatch.actionField`,
   * default `action`). A listed action's rule wins; an unlisted action falls
   * back to the tool-level rule, which is normally absent.
   */
  actions?: Record<string, ConfirmRule>;
}

/**
 * Returned INSTEAD of doing the work when a write needs a human. The platform
 * replaces your whole result with the decision card on this pass, so nothing
 * beside `_approval` reaches anyone; put everything the person needs to read
 * in `question`, `header` and `summary`.
 */
export interface AppApprovalEnvelope {
  /** The question on the card, e.g. "Delete 12 products from acme.myshopify.com?" */
  question: string;
  /** Short header above the card, e.g. "Shopify". */
  header: string;
  /** Optional detail under the approve option; the card is the whole preview. */
  summary?: string;
  /**
   * Stable identity of the exact operation. SUPPLY THIS for any tool with
   * optional arguments: the platform's default is derived from whatever the
   * model happened to send, and a hash that moves between the ask and the
   * retry silently discards the tap. See `approvalHash`.
   */
  hash?: string;
}

/**
 * Platform-stamped marker telling an app that a human approved this call. The
 * platform DELETES any caller-supplied copy before dispatch and sets it only
 * after consuming a real grant, so a handler may trust it.
 */
export const APPROVAL_GRANTED_KEY = '_approval_granted';

export type UndoFidelity = 'full' | 'recreated';

/**
 * Returned BESIDE the real result after a successful write. Every field is
 * required and non-empty: the platform drops the whole envelope on a blank
 * field and mints nothing, silently. Build it with `undoEnvelope()`, which
 * refuses a blank at construction time.
 */
export interface AppUndoEnvelope {
  /** `'full'`: same id restored in place. `'recreated'`: a NEW object under a NEW id. */
  fidelity: UndoFidelity;
  /** Relayed to the model verbatim. On `'recreated'` it must say the id changes. */
  warning: string;
  /** Human-readable subject for the list tool, e.g. `collection "Summer Sale" on acme.myshopify.com`. */
  describes: string;
  /** Coarse type, for grouping: "product", "contact". */
  resource: string;
  /** The app's own handle for the before-image (`journal.captureBefore().ref`). */
  ref: string;
}

/** Args-first handler signature the marketplace wrapper dispatches with. */
export type ToolArgs = Record<string, unknown>;
export type ToolHandler<E = unknown> = (args: ToolArgs, env: E, ctx?: unknown) => Promise<unknown>;

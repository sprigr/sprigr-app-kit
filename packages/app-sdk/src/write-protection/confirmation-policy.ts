import type { ConfirmRule, ConfirmationPolicy } from './types';

/**
 * Declare a dispatcher tool's confirmation policy beside its action registry,
 * emit it into the manifest with a `gen:` script, and let a test prove that
 * every write action is either gated or knowingly exempt.
 *
 * This is the Xero app's `confirmation-policy.ts` + its test, generalised. The
 * two things that fail SILENTLY are what the checker exists for: a rule keyed
 * on an action that does not exist (dead rule, no gate, no error) and a
 * placeholder path that renders "(unset)" in the prompt a human is asked to
 * approve.
 */

export interface PolicySource {
  /** Money has left, a customer has been mailed, or the vendor offers no way back. */
  irreversible?: Record<string, string>;
  /** Gated on every call, reversible but real. */
  always?: Record<string, string>;
  /** Full rules, for thresholds and anything the two maps above cannot express. */
  rules?: Record<string, ConfirmRule>;
  /**
   * The actions an approval spec covers: pass the keys of the specs object you
   * hand to `dispatcherApproval` (`Object.keys(APPROVAL_SPECS)`). Each one that
   * also has a rule here gets `attended: 'approval_card'`, so the person is
   * asked once on an attended turn (the card) instead of twice. An action with
   * a spec and no rule is left alone: it already asks once.
   *
   * Leave out any action your app gates conditionally around the gate (for
   * example a delete that only reaches `gate.run` with `force: true`): on the
   * shapes that skip the card, the confirmation would be the only prompt.
   */
  approvalCovered?: Iterable<string>;
}

/** Build a sorted `{ actions }` policy. An action named in two groups throws. */
export function buildConfirmationPolicy(src: PolicySource): ConfirmationPolicy {
  const actions: Record<string, ConfirmRule> = {};
  const put = (name: string, rule: ConfirmRule, group: string) => {
    if (actions[name]) throw new Error(`buildConfirmationPolicy: "${name}" is declared twice (second time in ${group})`);
    actions[name] = rule;
  };
  for (const [name, describe] of Object.entries(src.irreversible ?? {})) put(name, { always: true, describe, irreversible: true }, 'irreversible');
  for (const [name, describe] of Object.entries(src.always ?? {})) put(name, { always: true, describe }, 'always');
  for (const [name, rule] of Object.entries(src.rules ?? {})) put(name, rule, 'rules');
  for (const name of src.approvalCovered ?? []) {
    if (actions[name]) actions[name] = { ...actions[name], attended: 'approval_card' };
  }
  return { actions: Object.fromEntries(Object.entries(actions).sort(([a], [b]) => a.localeCompare(b))) };
}

/**
 * Action-name prefixes that mean "this writes". Used only for coverage: every
 * registry action with one of these prefixes must be gated or listed as
 * deliberately ungated. Reads (`get_`, `list_`, `search_`) are not here.
 */
export const DEFAULT_WRITE_PREFIXES: readonly string[] = [
  'create_', 'update_', 'delete_', 'remove_', 'set_', 'add_', 'archive_', 'unarchive_', 'void_',
  'refund_', 'cancel_', 'send_', 'email_', 'post_', 'publish_', 'unpublish_', 'approve_', 'reject_',
  'submit_', 'allocate_', 'mark_', 'complete_', 'reopen_', 'convert_', 'clone_', 'upload_', 'attach_',
  'detach_', 'move_', 'merge_', 'assign_', 'unassign_', 'pay_', 'capture_', 'process_', 'apply_',
  'authorise_', 'authorize_', 'register_', 'unregister_', 'rotate_', 'revoke_', 'clear_', 'reset_',
  'purge_', 'force_', 'import_', 'push_', 'invite_', 'swap_', 'bulk_', 'batch_', 'unship_', 'offboard_',
  'hold_', 'release_', 'retry_', 'trigger_', 'record_', 'adjust_', 'receive_', 'dispatch_', 'transfer_',
  'link_', 'unlink_', 'enable_', 'disable_', 'pause_', 'resume_', 'restore_', 'replace_', 'insert_',
  'patch_', 'put_', 'write_', 'save_', 'book_', 'schedule_', 'reschedule_', 'escalate_', 'resolve_',
  'dismiss_', 'accept_', 'decline_', 'follow_', 'unfollow_', 'like_', 'comment_', 'deactivate_',
  'activate_', 'suspend_', 'generate_', 'issue_', 'charge_',
];

/** Fields a threshold must never be placed on: a numeric string never trips. */
export const DEFAULT_MONEY_FIELDS: readonly string[] = ['amount', 'total', 'unit_amount', 'sub_total', 'price', 'budget'];

export interface PolicyCheckInput {
  policy: ConfirmationPolicy;
  /** Every dispatchable action name (the registry KEYS). */
  registry: Iterable<string>;
  /** Write actions deliberately left ungated, each a conscious choice. */
  ungated?: readonly string[];
  writePrefixes?: readonly string[];
  /**
   * The input fields an action REQUIRES. A `describe` may interpolate only
   * those (or a field named by its own `when.count`): an optional field is
   * absent on some calls by definition and renders as "(unset)". Omit to skip
   * this check.
   */
  requiredInput?: (action: string) => readonly string[] | undefined;
  /**
   * True (default) when the tool nests params under `input`: every placeholder
   * and count path must then be dotted through `input.`, because the platform
   * evaluates against the TOP-LEVEL args it reads `action` from.
   */
  nestedUnderInput?: boolean;
  moneyFields?: readonly string[];
  /**
   * The actions an approval spec covers (the keys of your `dispatcherApproval`
   * specs). With it, the check fails a rule carrying `attended:
   * 'approval_card'` that no spec covers (that key removes the person's only
   * prompt) and a covered, gated action that lacks the key (it asks twice).
   * Without it, any `attended` key is itself a finding, because nothing can
   * vouch for it.
   */
  approvalCovered?: Iterable<string>;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_.]+)\}/g;

function conditions(rule: ConfirmRule) {
  return !rule.when ? [] : Array.isArray(rule.when) ? rule.when : [rule.when];
}

/**
 * Findings for one rule's `attended` key against the approval specs. Exported
 * for apps whose gated tools are flat (`requireApproval`) rather than one
 * dispatcher: run it over each tool-level rule with the tool names the specs
 * cover.
 */
export function attendedFindings(name: string, rule: ConfirmRule, covered: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  const attended = (rule as { attended?: unknown }).attended;
  const gated = rule.always === true || conditions(rule).length > 0;
  if (attended !== undefined && attended !== 'approval_card') {
    out.push(`${name}: attended must be 'approval_card' (got ${JSON.stringify(attended)}); the platform ignores anything else`);
  } else if (attended === 'approval_card') {
    if (!covered) out.push(`${name}: attended: 'approval_card' cannot be checked; pass approvalCovered (the approval spec keys)`);
    else if (!covered.has(name)) out.push(`${name}: attended: 'approval_card' but no approval spec covers it, so it removes the only prompt`);
  } else if (covered?.has(name) && gated) {
    out.push(`${name}: an approval spec covers it but the rule lacks attended: 'approval_card', so it asks twice`);
  }
  return out;
}

/**
 * Every way a policy can be wrong without erroring, as a list of findings.
 * An app's test is `expect(checkConfirmationPolicy(...)).toEqual([])`.
 */
export function checkConfirmationPolicy(input: PolicyCheckInput): string[] {
  const registry = new Set(input.registry);
  const ungated = input.ungated ?? [];
  const prefixes = input.writePrefixes ?? DEFAULT_WRITE_PREFIXES;
  const nested = input.nestedUnderInput ?? true;
  const money = new Set(input.moneyFields ?? DEFAULT_MONEY_FIELDS);
  const actions = input.policy.actions ?? {};
  const covered = input.approvalCovered ? new Set(input.approvalCovered) : null;
  const out: string[] = [];

  for (const [name, rule] of Object.entries(actions)) {
    out.push(...attendedFindings(name, rule, covered));
    if (!registry.has(name)) out.push(`dead rule: "${name}" is not in the registry, so it gates nothing`);
    if (!rule.always && conditions(rule).length === 0) out.push(`${name}: rule says nothing (no always, no when)`);
    if (!rule.describe || !rule.describe.trim()) out.push(`${name}: describe missing`);
    else if (rule.describe.trim().endsWith('.')) out.push(`${name}: describe must not end in a period (platform renders "Action: <text>.")`);

    const required = new Set(input.requiredInput?.(name) ?? []);
    for (const c of conditions(rule)) {
      if (!(c.atLeast >= 1)) out.push(`${name}: atLeast must be >= 1 (${c.atLeast} is always true; use always: true)`);
      if (nested && !c.count.startsWith('input.')) out.push(`${name}: count "${c.count}" must be dotted through input.`);
      const leaf = c.count.split('.').pop() ?? '';
      if (money.has(leaf)) out.push(`${name}: threshold on money field "${c.count}" is bypassed by a numeric string; use always`);
      required.add(c.count.replace(/^input\./, '').split('.')[0] as string);
    }
    for (const m of (rule.describe ?? '').matchAll(PLACEHOLDER)) {
      const path = m[1] as string;
      if (nested && !path.startsWith('input.')) {
        out.push(`${name}: placeholder {${path}} is not under input. and will render as (unset)`);
        continue;
      }
      if (input.requiredInput) {
        const field = path.replace(/^input\./, '').replace(/\.length$/, '').split('.')[0] as string;
        if (!required.has(field)) out.push(`${name}: placeholder {${path}} reads "${field}", which the action does not require, so it renders as (unset) when omitted`);
      }
    }
  }

  for (const name of ungated) {
    if (!registry.has(name)) out.push(`ungated list: "${name}" is not in the registry`);
    if (actions[name]) out.push(`ungated list: "${name}" is also gated; remove one`);
  }

  for (const name of registry) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    if (actions[name] || ungated.includes(name)) continue;
    out.push(`unclassified write: "${name}" is neither gated nor listed as deliberately ungated`);
  }

  return out.sort();
}

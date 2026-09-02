import { approvalHash } from './approval-hash';
import { offerUndo, safeCapture } from './undo-capture';
import { APPROVAL_GRANTED_KEY, type AppApprovalEnvelope, type ToolArgs, type ToolHandler, type UndoFidelity } from './types';

/**
 * Human approval for the writes a vendor cannot undo, plus the before-image
 * capture for the ones it can partly undo, in ONE wrapper. Two shapes over the
 * same core:
 *
 *   requireApproval(handlers, specs, opts)   flat tools, one handler per tool
 *   dispatcherApproval(specs, opts)          one tool, many actions; the
 *                                            dispatcher calls gate.run(...)
 *
 * ## Why this exists when the manifest already declares `confirmation`
 *
 * The manifest tier gates on `confirm: true`, which the MODEL sets. Measured on
 * staging 2026-08-19: an agent wrote `confirm: true` into its own code_mode
 * source before any prompt, because the user's request ("add these five tags")
 * reads as the confirmation for that action. That tier is an audit trail; it is
 * not a control. `_approval` is the tier a model cannot satisfy alone: the
 * platform pauses the turn on a decision card, and only a real tap makes the
 * DecisionRouter write the grant that lets the retry through.
 *
 * ## The two rules baked in, both learned live
 *
 * 1. THE CONNECTION IS RESOLVED AND PINNED INSIDE THIS WRAPPER, before the card
 *    label lookup, the hash, and the capture. Apps establish their store /
 *    organisation / business pin inside their own inner wrapper; a gate that
 *    sits outside it sees an UNPINNED env, resolves the install's default
 *    connection, and (a) names the wrong store on the card, (b) hashes the
 *    wrong store so the retry misses the grant, and (c) captures the wrong
 *    store's copy so a permanent delete succeeds and mints no token. Shopify
 *    shipped all three from one cause (sprigr-team decision 0011 addendum).
 *
 * 2. CAPTURE BEFORE THE WRITE, MINT ONLY AFTER IT SUCCEEDS, AND NEVER RETURN
 *    `_undo` ON A NULL CAPTURE. A failed capture does not fail the write: the
 *    user asked for it and a human approved it. It degrades to no token.
 *
 * Generalised from the Shopify app's `require-approval.ts`; the per-tool
 * questions stay in the app, because only the app knows what cannot be walked
 * back.
 */

/** Per-tool (or per-action) spec: how the card reads, and (optionally) how to journal a before-image. */
export interface ApprovalSpec<P = unknown> {
  /**
   * Arg names that may carry the target id, most specific first. ONE list, used
   * for both the card label and the grant hash, so the two cannot drift apart
   * and describe different resources.
   */
  keys: string[];
  /**
   * The card. `target` is the already-resolved human label (or the raw id),
   * `connection` the resolved store / organisation / business, or '' when the
   * app has one. Do not set `hash` here; the wrapper derives it from the raw
   * id and the connection so it cannot move between the ask and the retry.
   * Extend with `hash` below only when the arguments understate the blast
   * radius.
   */
  describe: (target: string, args: ToolArgs, connection: string) => Omit<AppApprovalEnvelope, 'hash'>;
  /**
   * Extra identity parts beyond `rawId + connection`, e.g. a sorted tag set.
   * Use `set()` / `seq()` from `approval-hash`. Never include `confirm`.
   */
  hash?: (args: ToolArgs) => Array<string | number | undefined | null>;
  /**
   * How many records this call touches, for `_approval.count`. Omit for a
   * single-target tool (the wrapper reports 1 when a `keys` id resolved, and
   * nothing when none did). A batch action (delete these ids, tag these
   * products) MUST supply it, or it reports nothing and no standing approval
   * can ever cover it, which is the safe side but not the useful one.
   */
  count?: (args: ToolArgs) => number;
  /** Present only for tools whose write can be (partly) reversed. */
  undo?: UndoCaptureSpec<P>;
}

export interface UndoCaptureSpec<P = unknown> {
  /** Coarse type surfaced as `_undo.resource`. */
  resource: string;
  fidelity: UndoFidelity;
  /** Read the object BEFORE the write, through the PINNED env or state. Null or throw on miss. */
  capture: (pinned: P, id: string, args: ToolArgs) => Promise<unknown>;
  /** How the change reads in `list_undoable_changes`; the connection is appended by the wrapper. */
  describe: (before: Record<string, unknown>, id: string) => string;
  /** Relayed verbatim; on `'recreated'` it must say the id changes. Never empty. */
  warning: (id: string, before: Record<string, unknown>) => string;
}

/** The journal surface this wrapper needs; `createUndoJournal()` satisfies it. */
export interface CaptureJournal {
  captureBefore(args: {
    entity: string;
    originalId: string;
    before: unknown;
    connection: string | null;
  }): Promise<{ ref: string } | null>;
}

/**
 * `E` is the env the tool receives; `P` is what the pinned connection looks
 * like to `capture` and `describeTarget` (the same env re-pinned for Shopify,
 * a fresh per-actor token state for Xero or Asana).
 */
export interface ApprovalGateOptions<E, P = E> {
  /** Log prefix, e.g. `shopify-undo`. */
  scope: string;
  /**
   * Resolve the connection this call will ACTUALLY hit, from the caller's
   * arguments and the install, canonicalised (a label like "EU store" becomes
   * the real domain). Return '' for a single-connection app. Never read it off
   * the arguments alone: on the retry the model usually omits it.
   */
  resolveConnection: (env: E, args: ToolArgs) => Promise<string>;
  /**
   * Re-pin to a resolved connection so lookups and captures hit it. Omit when
   * `P` is `E` and the env needs no pin (a single-connection app).
   */
  pinEnv?: (env: E, connection: string) => P | Promise<P>;
  /**
   * Human label for a raw id, looked up THROUGH the pinned connection. Fall
   * back to the id on any miss; never guess, a confidently wrong card is worse
   * than a terse one. Omit to always show the raw id. `name` is the tool, or
   * for a dispatcher the action, so a lookup can route by resource type when
   * the id alone does not say what it is (an Asana gid).
   */
  describeTarget?: (pinned: P, id: string, name: string) => Promise<string>;
  /**
   * Where before-images go. Required when any spec declares `undo`. The
   * journal's own capture returns null rather than throwing, and this wrapper
   * treats null as "no undo offered".
   */
  journal?: (env: E) => CaptureJournal;
  /**
   * Stamp the resolved connection onto a successful result (e.g. `{ store }`)
   * so an agent reporting "deleted it" can name where. Optional.
   */
  stampConnection?: (result: unknown, connection: string) => unknown;
}

/** Flat-tool options: the pinned type is the env itself. */
export type RequireApprovalOptions<E> = ApprovalGateOptions<E, E>;

export interface DispatcherApprovalOptions<E, P = E> extends ApprovalGateOptions<E, P> {
  /**
   * Where the per-action params live on the dispatched args (`{ action,
   * input: {...} }` -> 'input'). When the field is absent the top-level args
   * are used, which is the flat-verb envelope. Default 'input'.
   */
  inputField?: string;
}

export interface DispatcherApprovalGate<E> {
  /** True when `action` carries an approval spec. */
  has(action: string): boolean;
  /**
   * Run one dispatched action through the gate. With no spec, `write` just
   * runs. With a spec, the ask pass returns the `_approval` card and never
   * calls `write`; the granted pass captures, calls `write`, and offers
   * `_undo` beside its result.
   */
  run(action: string, args: ToolArgs, env: E, write: () => Promise<unknown>): Promise<unknown>;
}

function rawIdOf(args: ToolArgs, keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if ((typeof v === 'string' && v) || typeof v === 'number') return String(v);
  }
  return '';
}

/**
 * The count the ask pass reports. A spec's own `count` wins; a single-target
 * spec that resolved an id is 1; anything else is unknown and stays off the
 * envelope, because a wrong count widens what an unattended step may write.
 */
function countOf(spec: ApprovalSpec<unknown>, params: ToolArgs, rawId: string): number | undefined {
  if (spec.count) {
    try {
      const n = spec.count(params);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    } catch {
      return undefined;
    }
  }
  return rawId ? 1 : undefined;
}

function isOk(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { ok?: unknown }).ok !== false;
}

async function safeLabel<P>(fn: (pinned: P, id: string, name: string) => Promise<string>, pinned: P, id: string, name: string): Promise<string> {
  try {
    const label = await fn(pinned, id, name);
    return label && label.trim() ? label : id;
  } catch {
    return id;
  }
}

async function pin<E, P>(opts: ApprovalGateOptions<E, P>, env: E, connection: string): Promise<P> {
  if (!connection || !opts.pinEnv) return env as unknown as P;
  return opts.pinEnv(env, connection);
}

/**
 * The ask pass: resolve ONCE and use the same value for the card text and the
 * hash, so the person is told exactly which connection they are authorising
 * and the grant cannot be invalidated by the model dropping `store` on the
 * retry. `hashPrefix` is the action name for a dispatcher, because the
 * platform mixes in only the TOOL name and every action shares one tool.
 */
async function askPass<E, P>(
  name: string,
  spec: ApprovalSpec<P>,
  params: ToolArgs,
  env: E,
  opts: ApprovalGateOptions<E, P>,
  hashPrefix: string[],
): Promise<{ ok: false; _approval: AppApprovalEnvelope }> {
  const connection = await opts.resolveConnection(env, params);
  const rawId = rawIdOf(params, spec.keys);
  const pinned = await pin(opts, env, connection);
  const target = rawId && opts.describeTarget ? await safeLabel(opts.describeTarget, pinned, rawId, name) : rawId || '(unknown id)';
  const extra = spec.hash ? spec.hash(params) : [];
  const count = countOf(spec as ApprovalSpec<unknown>, params, rawId);
  return {
    ok: false,
    _approval: {
      ...spec.describe(target, params, connection),
      hash: approvalHash(...hashPrefix, rawId, connection, ...extra),
      ...(count !== undefined ? { count } : {}),
    },
  };
}

/**
 * The granted pass: capture THROUGH the pinned connection BEFORE the write,
 * mint only after the write reported ok, never on a null capture. Verified
 * live 2026-08-20: an unpinned capture went looking on the default store,
 * found nothing, and a permanent delete on the other store minted no token.
 */
async function grantedPass<E, P>(
  name: string,
  spec: ApprovalSpec<P>,
  params: ToolArgs,
  env: E,
  opts: ApprovalGateOptions<E, P>,
  write: () => Promise<unknown>,
): Promise<unknown> {
  // Even with nothing to journal, name the connection this hit. An agent that
  // reports "deleted it" without naming the store on a multi-store install is
  // one the user cannot check.
  const connection = await opts.resolveConnection(env, params);
  const stamp = (r: unknown) => (connection && opts.stampConnection ? opts.stampConnection(r, connection) : r);

  const undo = spec.undo;
  const id = rawIdOf(params, spec.keys);
  if (!undo || !id) return stamp(await write());

  const pinned = await pin(opts, env, connection);
  const before = await safeCapture(opts.scope, name, id, () => undo.capture(pinned, id, params));

  const result = await write();
  if (!isOk(result) || !before) return stamp(result);

  const envelope = await offerUndo({
    journal: opts.journal!(env),
    entity: name,
    id,
    before,
    connection: connection || null,
    fidelity: undo.fidelity,
    resource: undo.resource,
    describe: undo.describe,
    warning: undo.warning(id, before),
  });
  if (!envelope) return stamp(result);
  return { ...(stamp(result) as Record<string, unknown>), _undo: envelope };
}

function assertJournal<E, P>(name: string, spec: ApprovalSpec<P>, opts: ApprovalGateOptions<E, P>, who: string): void {
  if (spec.undo && !opts.journal) {
    throw new Error(`${who}: "${name}" declares undo but no journal was supplied.`);
  }
}

/**
 * Wrap the named flat tools so each asks a human first, then (if it declares
 * `undo`) journals a before-image on the granted pass and offers `_undo`.
 *
 * Returns only the wrapped entries. Register them AFTER the originals
 * (`Object.assign(registry, requireApproval(registry, specs, opts))`) so
 * last-write-wins puts the gated version in front.
 *
 * A spec naming a tool absent from `handlers` throws rather than skipping: a
 * rename that quietly ungated a permanent delete is exactly the failure this
 * guard exists to prevent, and it would look identical to working.
 */
export function requireApproval<E>(
  handlers: Record<string, ToolHandler<E>>,
  specs: Record<string, ApprovalSpec<E>>,
  opts: RequireApprovalOptions<E>,
): Record<string, ToolHandler<E>> {
  const gated: Record<string, ToolHandler<E>> = {};

  for (const [name, spec] of Object.entries(specs)) {
    const inner = handlers[name];
    if (!inner) {
      throw new Error(
        `requireApproval: "${name}" has an approval spec but is not in the handler registry. ` +
          'It was probably renamed or removed; update the specs in the same change, or a ' +
          'destructive tool ships ungated.',
      );
    }
    assertJournal(name, spec, opts, 'requireApproval');

    gated[name] = async (args, env, ctx) => {
      const a = args ?? {};
      if (a[APPROVAL_GRANTED_KEY] === true) {
        const { [APPROVAL_GRANTED_KEY]: _granted, ...rest } = a;
        return grantedPass(name, spec, rest, env, opts, () => inner(rest, env, ctx));
      }
      return askPass(name, spec, a, env, opts, []);
    };
  }

  return gated;
}

/**
 * The same gate for a dispatcher tool (one tool, many actions selected by an
 * input field). Build it once beside the action registry and call `run` from
 * the dispatcher after the action is resolved and its params parsed:
 *
 *   const gate = dispatcherApproval(SPECS, { scope, resolveConnection, pinEnv, journal });
 *   ...
 *   return gate.run(action, args, env, () => def.execute(state, parsed));
 *
 * The platform stamps `_approval_granted` on the TOP-LEVEL args; the per-action
 * params are read from `opts.inputField` (default `input`), or from the
 * top-level args when that field is absent (the flat-verb envelope).
 */
export function dispatcherApproval<E, P = E>(
  specs: Record<string, ApprovalSpec<P>>,
  opts: DispatcherApprovalOptions<E, P>,
): DispatcherApprovalGate<E> {
  for (const [name, spec] of Object.entries(specs)) assertJournal(name, spec, opts, 'dispatcherApproval');
  const field = opts.inputField ?? 'input';

  return {
    has: (action) => Object.prototype.hasOwnProperty.call(specs, action),
    async run(action, args, env, write) {
      const spec = specs[action];
      if (!spec) return write();
      const a = args ?? {};
      const nested = a[field];
      const params: ToolArgs =
        nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as ToolArgs) : a;
      if (a[APPROVAL_GRANTED_KEY] === true) {
        return grantedPass(action, spec, params, env, opts, write);
      }
      return askPass(action, spec, params, env, opts, [action]);
    },
  };
}

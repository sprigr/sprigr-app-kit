import { undoEnvelope } from './undo-envelope';
import type { AppUndoEnvelope, UndoFidelity } from './types';
import type { CaptureJournal } from './require-approval';

/**
 * The two halves of offering an undo, for handlers that are not behind an
 * approval card (a dispatcher's `update_*` actions, for instance). The order
 * is the whole contract:
 *
 *   const before = await safeCapture(scope, action, id, () => read(pinned, id));
 *   const result = await write(pinned, input);              // happens regardless
 *   const _undo  = await offerUndo({ journal, entity: action, id, before, connection, ... });
 *   return { ok: true, result, ...(_undo ? { _undo } : {}) };
 *
 * `requireApproval` uses the same two functions on its granted pass.
 */

/**
 * Read the before-image, degrading to null on any failure. A capture that
 * throws (404, scope denied, network) is not a reason to refuse a write the
 * user asked for; it is a reason to offer no undo, and to say so in the log.
 */
export async function safeCapture(
  scope: string,
  name: string,
  id: string,
  capture: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const got = await capture();
    return got && typeof got === 'object' ? (got as Record<string, unknown>) : null;
  } catch (err) {
    console.warn(`[${scope}] ${name} ${id}: capture failed, writing without undo: ${String(err)}`);
    return null;
  }
}

export interface OfferUndoArgs {
  journal: CaptureJournal;
  /** The tool or action that captured; the reverse tool looks the spec up by it. */
  entity: string;
  id: string;
  /** From `safeCapture`. Null means no undo is offered, deliberately. */
  before: Record<string, unknown> | null;
  /** The resolved store / organisation / business, or null for a single-connection app. */
  connection: string | null;
  fidelity: UndoFidelity;
  resource: string;
  /** How the change reads in `list_undoable_changes`; the connection is appended when present. */
  describe: (before: Record<string, unknown>, id: string) => string;
  /** Relayed verbatim; never empty. */
  warning: string;
  /** Word between the description and the connection: "on" for a store, "in" for an organisation. */
  connectionPreposition?: 'on' | 'in';
  /**
   * What `describes` calls the connection, when the journalled id is not
   * readable by a person (a Xero tenantId). Defaults to `connection`. The
   * journal row always stores `connection` itself, because that is the pin.
   */
  connectionLabel?: string;
}

/**
 * Store the before-image and build the `_undo` envelope, or return undefined
 * when there is nothing to offer. Never returns an envelope for a null capture
 * or a journal that could not store the copy.
 */
export async function offerUndo(args: OfferUndoArgs): Promise<AppUndoEnvelope | undefined> {
  if (!args.before) return undefined;
  const captured = await args.journal.captureBefore({
    entity: args.entity,
    originalId: args.id,
    before: args.before,
    connection: args.connection,
  });
  if (!captured) return undefined;
  const base = args.describe(args.before, args.id);
  const prep = args.connectionPreposition ?? 'on';
  const label = args.connectionLabel ?? args.connection;
  return undoEnvelope({
    fidelity: args.fidelity,
    warning: args.warning,
    describes: label ? `${base} ${prep} ${label}` : base,
    resource: args.resource,
    ref: captured.ref,
  });
}

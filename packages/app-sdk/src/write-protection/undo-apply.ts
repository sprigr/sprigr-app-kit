/**
 * The reversal entry point every adopting app declares as `undo.reverse_tool`.
 *
 * Declared `internal: true` in the manifest, so the platform can dispatch it
 * but no agent ever sees it: an agent that can see a reversal entry point can
 * call it with an invented handle, and an agent inventing a plausible undo
 * identifier is a thing that happened on the simPRO shakedown. The platform
 * resolves its own token first and only then dispatches here with
 * `{ ref, undo_token }`.
 *
 * By the time this runs the platform has checked that the token exists,
 * belongs to this actor and company, has not expired, and has been claimed
 * exactly once. This runner re-checks none of that, because it cannot. It does
 * one thing: load the copy, re-pin the connection the original write hit,
 * hand both to the app's restore, and report honestly.
 *
 * THE RE-PIN IS THE WHOLE GAME. The platform dispatches with no memory of
 * which store / organisation / business the original write targeted. Without
 * `pin`, a replay lands on the install's CURRENT default and rebuilds the
 * object in the wrong customer account, and nothing errors.
 *
 * Extracted from the Shopify and Xero `undo-apply.ts` handlers, which were
 * byte-similar apart from their restore call and their pin.
 */

import type { ToolArgs, UndoFidelity } from './types';

export interface RestoreSpec<E, T = Record<string, unknown>> {
  resource: string;
  fidelity: UndoFidelity;
  /** Rebuild or write back, through the PINNED env. */
  restore: (pinnedEnv: E, before: T, row: JournalRowLike<T>) => Promise<{ ok: boolean; newId?: string; error?: string }>;
  /** What the restore does NOT bring back, folded into the note verbatim. */
  notRestored?: string;
}

export interface JournalRowLike<T = unknown> {
  entity: string;
  original_id: string;
  connection: string | null;
  before: T;
}

export interface UndoApplyOptions<E> {
  env: E;
  journal: {
    loadBefore<T = unknown>(ref: string): Promise<JournalRowLike<T> | null>;
    dropBefore(ref: string): Promise<void>;
  };
  specs: Record<string, RestoreSpec<E>>;
  /**
   * Re-pin the env to the journalled connection. May be async (re-auth per
   * actor, as Xero does) and may throw or return null to REFUSE, e.g. a
   * session-stateful app whose current business differs from the row's.
   */
  pin: (env: E, connection: string | null, args: ToolArgs) => Promise<E | null> | E | null;
}

export type UndoApplyResult =
  | { ok: true; resource: string; original_id: string; connection: string | null; new_id: string | null; fidelity: UndoFidelity; not_restored?: string; note: string }
  | { ok: false; error: string; note: string };

/** Run the reversal. Every failure names what it was and states that nothing changed. */
export async function runUndoApply<E>(args: ToolArgs, opts: UndoApplyOptions<E>): Promise<UndoApplyResult> {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  if (!ref) return { ok: false, error: 'missing_ref', note: 'No before-image reference was supplied. Nothing was changed.' };

  const row = await opts.journal.loadBefore<Record<string, unknown>>(ref);
  if (!row) {
    // Reachable when the journal aged out before the platform's token did, or
    // the install's D1 was reset. Report it plainly rather than guessing.
    return {
      ok: false,
      error: 'before_image_missing',
      note: 'The saved copy of this record is no longer available, so it cannot be restored. Nothing was changed.',
    };
  }

  // Looked up by the TOOL that captured, so a registry entry renamed or removed
  // between capture and reversal fails loudly instead of replaying against the
  // wrong shape.
  const spec = opts.specs[row.entity];
  if (!spec) {
    return {
      ok: false,
      error: 'undo_no_longer_supported',
      note: `This app no longer knows how to reverse a "${row.entity}" change. Nothing was changed.`,
    };
  }

  const before = row.before;
  if (!before || typeof before !== 'object') {
    return { ok: false, error: 'before_image_unreadable', note: 'The saved copy could not be read back. Nothing was changed.' };
  }

  let pinned: E | null;
  try {
    pinned = await opts.pin(opts.env, row.connection, args);
  } catch (err) {
    return {
      ok: false,
      error: 'connection_unavailable',
      note: `Could not reach the connection this change was made in${row.connection ? ` (${row.connection})` : ''}: ${String(err)}. Nothing was changed.`,
    };
  }
  if (!pinned) {
    return {
      ok: false,
      error: 'connection_mismatch',
      note:
        `This change was made in ${row.connection ?? 'a different connection'}, which is not the one currently selected. ` +
        'Switch to it and retry. Nothing was changed.',
    };
  }

  const result = await spec.restore(pinned, before, row);
  if (!result.ok) {
    // Leave the before-image in place: the platform has marked its token
    // spent, but a human may still want to see what was held.
    return {
      ok: false,
      error: 'restore_failed',
      note: `The provider refused to restore the ${spec.resource}: ${result.error ?? 'unknown error'}. Nothing was restored.`,
    };
  }

  // Restored, so stop holding the copy. Best-effort; it ages out regardless.
  await opts.journal.dropBefore(ref);

  const recreated = spec.fidelity === 'recreated';
  return {
    ok: true,
    resource: spec.resource,
    original_id: row.original_id,
    connection: row.connection,
    new_id: result.newId ?? null,
    fidelity: spec.fidelity,
    ...(spec.notRestored ? { not_restored: spec.notRestored } : {}),
    note: recreated
      ? `Created a NEW ${spec.resource}${result.newId ? ` (${result.newId})` : ''} from the saved copy. ` +
        `The original ${row.original_id} is still gone and its id will never be reissued.` +
        `${spec.notRestored ? ` Not restored: ${spec.notRestored}.` : ''} Report this as a replacement, not as an undo.`
      : `Restored ${spec.resource} ${row.original_id} to its saved values.` +
        `${spec.notRestored ? ` Not restored: ${spec.notRestored}.` : ''} Anything changed since the capture was overwritten.`,
  };
}

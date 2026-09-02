import type { AppUndoEnvelope, UndoFidelity } from './types';

/**
 * Thrown by `undoEnvelope` for a field the platform would reject.
 *
 * The platform's `extractAppUndo` requires `fidelity` in {full, recreated} and
 * every string non-empty after trim; on any miss it logs a warning in the
 * PLATFORM worker and mints no token. The app sees nothing wrong: the write
 * succeeds and the journal row is there. The only symptom is that the model
 * never gets an undo affordance, which reads as a discoverability problem and
 * sends you into the tool registry instead of your own envelope. Xero 0.1.1
 * shipped `warning: ''` this way. Failing here, in a unit test, is cheaper.
 */
export class InvalidUndoEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUndoEnvelopeError';
  }
}

/** Build an `_undo` envelope, refusing anything the platform would drop. */
export function undoEnvelope(input: {
  fidelity: UndoFidelity;
  warning: string;
  describes: string;
  resource: string;
  ref: string;
}): AppUndoEnvelope {
  if (input.fidelity !== 'full' && input.fidelity !== 'recreated') {
    throw new InvalidUndoEnvelopeError(
      `_undo.fidelity must be 'full' or 'recreated', got ${JSON.stringify(input.fidelity)}`,
    );
  }
  for (const key of ['warning', 'describes', 'resource', 'ref'] as const) {
    const v = input[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new InvalidUndoEnvelopeError(
        `_undo.${key} must be a non-empty string; the platform drops the whole envelope and mints no token on a blank field`,
      );
    }
  }
  return {
    fidelity: input.fidelity,
    warning: input.warning.trim(),
    describes: input.describes.trim(),
    resource: input.resource.trim(),
    ref: input.ref,
  };
}

/**
 * The honest warning for a `'recreated'` reversal. Always names the new-id
 * consequence, then whatever the rebuild cannot bring back.
 */
export function recreatedWarning(resource: string, notRestored?: string): string {
  const base =
    `Not a true undo: the original ${resource} is permanently gone and its id will never be ` +
    `reissued. Reversing creates a NEW ${resource} from the saved copy, under a new id, so ` +
    `anything that referenced the old id stays broken.`;
  return notRestored && notRestored.trim() ? `${base} Not restored: ${notRestored.trim()}.` : base;
}

/**
 * The honest warning for a `'full'` reversal. Even a perfect revert overwrites
 * anything changed since the capture, so this is never empty.
 */
export function fullWarning(notRestored?: string): string {
  const base =
    'Reversing writes the previously saved values back over the record, so any change made ' +
    'to it since then is overwritten.';
  return notRestored && notRestored.trim() ? `${base} It does not restore ${notRestored.trim()}.` : base;
}

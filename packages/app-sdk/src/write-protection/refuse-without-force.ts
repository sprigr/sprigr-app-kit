import type { ToolArgs, ToolHandler } from './types';

/**
 * Archive-first: a delete refuses ONCE and offers the reversible option.
 *
 * Where the vendor has a real archived state, a native archive beats any
 * journal: same id, real restore, no fidelity caveat. So a `delete_*` on such
 * an entity does not delete unless the caller passes `force: true`; it returns
 * a refusal pointing at the archive tool. Automation that genuinely means to
 * delete adds `force: true` once; a person who said "get rid of it" is offered
 * the thing they almost certainly meant.
 *
 * The refusal shape is shared by simPRO (five deletes) and Shopify
 * (`shopify_delete_product`) so an agent that has learned one has learned both:
 * "I did NOT write; here is the reversible option; pass force: true if you
 * really mean it".
 */
export interface ArchiveOfferOptions {
  /** Human noun: "product", "customer". */
  resource: string;
  /** Tool or action name the caller should reach for instead. */
  archiveAction: string;
  /** Arg names that may carry the target id, most specific first. */
  idKeys?: string[];
  /** Deep link to the record, when a verified single-record URL shape exists. */
  link?: (args: ToolArgs, id: string) => string | undefined;
}

export interface ArchiveOfferRefusal {
  ok: false;
  deleted: false;
  archive_available: true;
  resource: string;
  record_id: string | null;
  delete_action: string;
  archive_action: string;
  link?: string;
  note: string;
}

function idOf(args: ToolArgs, keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v);
  }
  return null;
}

/** The refusal payload, for dispatcher apps that wrap at the action layer. */
export function archiveOfferRefusal(
  deleteAction: string,
  args: ToolArgs,
  opts: ArchiveOfferOptions,
): ArchiveOfferRefusal {
  const id = idOf(args, opts.idKeys ?? ['id']);
  const link = id && opts.link ? opts.link(args, id) : undefined;
  return {
    ok: false,
    deleted: false,
    archive_available: true,
    resource: opts.resource,
    record_id: id,
    delete_action: deleteAction,
    archive_action: opts.archiveAction,
    ...(link ? { link } : {}),
    note:
      `Nothing was deleted. This ${opts.resource}${id ? ` (${id})` : ''} can be ARCHIVED instead with ` +
      `${opts.archiveAction}, which keeps its id and is reversible; a delete throws the id away for ` +
      `good and cannot be undone. Offer the archive to the person first. If they explicitly want it ` +
      `destroyed even though it cannot be recovered, call ${deleteAction} again with force: true.`,
  };
}

/**
 * Wrap a flat delete handler so an un-forced call returns the offer instead.
 * `force` is consumed here and never forwarded to the provider.
 */
export function refuseWithoutForce<E>(
  deleteAction: string,
  inner: ToolHandler<E>,
  opts: ArchiveOfferOptions,
): ToolHandler<E> {
  return async (args, env, ctx) => {
    const a = args ?? {};
    if (a.force === true) {
      const { force: _force, ...rest } = a;
      return inner(rest, env, ctx);
    }
    return archiveOfferRefusal(deleteAction, a, opts);
  };
}

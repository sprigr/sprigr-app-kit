/**
 * Stamping: turn source entries into index rows with validated principals.
 * Shared by the walk, the extra scopes, the permission re-stamp and the
 * content-fill drain, so every path applies the same fail-closed rules.
 */

import { stampedPrincipalsValid, userPrincipal } from './doc-acl';
import type { FileIndexingContext, FileIndexingEnv, FileSourceAdapter, IndexedFileObject, ResolvedPrincipals } from './types';

/** The owner principal every row carries (adapter.ownerPrincipal, else the
 *  row's connected email). */
export function ownerPrincipalOf<TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<any, TEnv>,
  ctx: FileIndexingContext<TEnv>,
): string | null {
  if (adapter.ownerPrincipal) return adapter.ownerPrincipal(ctx);
  return ctx.ownerEmail ? userPrincipal(ctx.ownerEmail) : null;
}

/** Stamp a batch: resolve, apply the owner, validate, map. */
export async function stampEntries<TEntry, TEnv extends FileIndexingEnv>(
  adapter: FileSourceAdapter<TEntry, TEnv>,
  ctx: FileIndexingContext<TEnv>,
  entries: TEntry[],
): Promise<{ objects: IndexedFileObject[]; mimes: Array<[string, string]>; skipped: number; unresolved: number }> {
  const objects: IndexedFileObject[] = [];
  const mimes: Array<[string, string]> = [];
  let skipped = 0;
  let unresolved = 0;
  if (entries.length === 0) return { objects, mimes, skipped, unresolved };
  const resolved = await adapter.resolvePrincipals(entries, ctx);
  const owner = ownerPrincipalOf(adapter, ctx);
  for (const entry of entries) {
    const r: ResolvedPrincipals | undefined = resolved.get(adapter.objectIdOf(entry, ctx));
    if (r === undefined || r === 'unresolved') {
      unresolved++;
      continue;
    }
    if (r === 'denied') {
      skipped++;
      continue;
    }
    const principals = owner && !r.includes(owner) ? [...r, owner] : r;
    if (!stampedPrincipalsValid(principals)) {
      skipped++;
      continue;
    }
    const obj = adapter.toObject(entry, principals, ctx);
    mimes.push([obj.objectID, adapter.mimeTypeOf ? adapter.mimeTypeOf(entry) : String(obj.mimeType ?? '')]);
    objects.push(obj);
  }
  return { objects, mimes, skipped, unresolved };
}

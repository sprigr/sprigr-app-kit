/**
 * The one write path into the ACL file index: `data.import(objects,
 * { withAcl: true })` in batches of the platform's per-call cap, with every
 * row validated BEFORE it is sent.
 *
 * The platform rejects the WHOLE batch when any row lacks a valid non-empty
 * `acl_principals`, so one bad row would strand every good row beside it and,
 * through the import-before-cursor rule, the cursor too. A row that fails
 * validation here is never sent: it is logged and reported back, and the rest
 * of the batch goes through. Principals are normalised on the way (lowercased
 * `user:` emails), which is a no-op for a mapper that already built them with
 * userPrincipal.
 */

import { isValidPrincipal, normalizePrincipal, stampedPrincipalsValid } from './doc-acl';
import type { FileIndexingEnv, IndexedFileObject } from './types';

/** Platform per-call import cap (sprigr-team wfp-data MAX_OBJECTS_PER_CALL). */
export const MAX_OBJECTS_PER_IMPORT = 1000;

/** Split objects into importable rows (principals normalised) and rejects. */
export function partitionValidObjects(objects: IndexedFileObject[]): {
  valid: IndexedFileObject[];
  rejected: string[];
} {
  const valid: IndexedFileObject[] = [];
  const rejected: string[] = [];
  for (const obj of objects) {
    const id = obj?.objectID;
    const principals = obj?.acl_principals;
    if (typeof id !== 'string' || id.length === 0 || !Array.isArray(principals) || !stampedPrincipalsValid(principals)) {
      rejected.push(typeof id === 'string' ? id : '(no objectID)');
      continue;
    }
    valid.push({ ...obj, acl_principals: principals.filter(isValidPrincipal).map(normalizePrincipal) });
  }
  return { valid, rejected };
}

/**
 * Import file rows through the withAcl contract, chunked at the per-call cap.
 * THROWS when the data surface is missing or an import fails, so the caller
 * keeps its cursor. Returns how many rows the platform reports indexed.
 */
export async function importFileObjects(
  env: FileIndexingEnv,
  objects: IndexedFileObject[],
  opts: { label?: string } = {},
): Promise<number> {
  if (objects.length === 0) return 0;
  const data = env.SPRIGR?.data;
  if (!data) {
    throw new Error('data_unavailable: env.SPRIGR.data missing (no bridge and no HTTP fallback bindings)');
  }
  const { valid, rejected } = partitionValidObjects(objects);
  if (rejected.length > 0) {
    console.warn(
      `${opts.label ?? '[file-indexing]'} ${rejected.length} row(s) failed principal validation and were not sent: ${rejected
        .slice(0, 5)
        .join(', ')}`,
    );
  }
  let imported = 0;
  for (let i = 0; i < valid.length; i += MAX_OBJECTS_PER_IMPORT) {
    const chunk = valid.slice(i, i + MAX_OBJECTS_PER_IMPORT);
    const resp = await data.import(chunk, { withAcl: true });
    imported += typeof resp?.indexed === 'number' ? resp.indexed : chunk.length;
  }
  return imported;
}

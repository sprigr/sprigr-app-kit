/**
 * A fake platform: the ACL index and the plain index as maps, with import /
 * delete / listIds / partialUpdate behaving like the wrapper (withAcl picks
 * the index, partialUpdate never creates rows), plus emit, files and acl.
 */
import type { FileIndexingEnv, FilesExtractResult, FilesJobResult } from '../../src/types';

export interface FakePlatform {
  env: FileIndexingEnv;
  acl: Map<string, Record<string, unknown>>;
  plain: Map<string, Record<string, unknown>>;
  imports: Array<Array<Record<string, unknown>>>;
  deletes: string[][];
  emitted: Array<{ name: string; payload: Record<string, unknown> }>;
  staged: Map<string, Uint8Array>;
  stagedDeletes: string[];
  extractCalls: Array<{ file_key: string; format?: string; job_token?: string }>;
  jobs: Map<string, FilesJobResult>;
  links: Array<{ op: 'link' | 'unlink'; owner: unknown; email?: string }>;
  /** Make extract answer this for a format. */
  extractAnswer: (format: string, text: string, jobToken?: string) => FilesExtractResult;
  failImport: boolean;
  emitDelayMs: number;
  emitFailFor: Set<string>;
  listTruncated: boolean;
  partialUpdateIndex: string;
}

export function makeFakePlatform(opts: { withListIds?: boolean; withDelete?: boolean } = {}): FakePlatform {
  const withListIds = opts.withListIds !== false;
  const withDelete = opts.withDelete !== false;
  const fp: FakePlatform = {
    env: {},
    acl: new Map(),
    plain: new Map(),
    imports: [],
    deletes: [],
    emitted: [],
    staged: new Map(),
    stagedDeletes: [],
    extractCalls: [],
    jobs: new Map(),
    links: [],
    extractAnswer: (format, text, jobToken) =>
      format === 'pptx' ? { ok: true, needs_job: true, job_token: jobToken ?? 'job-auto' } : { ok: true, text },
    failImport: false,
    emitDelayMs: 0,
    emitFailFor: new Set(),
    listTruncated: false,
    partialUpdateIndex: 'comp_1-app-test-acl-files',
  };
  const data: NonNullable<NonNullable<FileIndexingEnv['SPRIGR']>['data']> = {
    async import(objects, o) {
      if (fp.failImport) throw new Error('import exploded');
      for (const obj of objects) {
        const principals = (obj as { acl_principals?: unknown }).acl_principals;
        if (o?.withAcl && (!Array.isArray(principals) || principals.length === 0)) {
          throw new Error('400 missing_acl_principals: the whole batch is rejected');
        }
      }
      fp.imports.push(objects.map((x) => ({ ...x })));
      const target = o?.withAcl ? fp.acl : fp.plain;
      for (const obj of objects) target.set(obj.objectID, { ...obj });
      return { ok: true, indexed: objects.length, index: 'x' };
    },
    ...(withDelete
      ? {
          async delete(ids: string[], o?: { withAcl?: boolean }) {
            fp.deletes.push([...ids]);
            const target = o?.withAcl ? fp.acl : fp.plain;
            for (const id of ids) target.delete(id);
            return { ok: true };
          },
        }
      : {}),
    ...(withListIds
      ? {
          async listIds(prefix: string, o?: { withAcl?: boolean }) {
            const target = o?.withAcl ? fp.acl : fp.plain;
            const ids = [...target.keys()].filter((k) => k.startsWith(prefix)).sort();
            return { objectIDs: fp.listTruncated ? ids.slice(0, 1) : ids, truncated: fp.listTruncated };
          },
        }
      : {}),
    async partialUpdate(objects, o) {
      let updated = 0;
      let skippedMissing = 0;
      for (const p of objects) {
        const row = (o?.withAcl ? fp.acl : fp.plain).get(p.objectID);
        if (!row) {
          skippedMissing++;
          continue;
        }
        if (JSON.stringify(row.acl_principals) !== JSON.stringify(p.acl_principals)) updated++;
        Object.assign(row, p);
      }
      return { ok: true, updated, skippedMissing, index: fp.partialUpdateIndex };
    },
  };
  fp.env = {
    SPRIGR: {
      data,
      async emit(name: string, payload: unknown) {
        if (fp.emitDelayMs) await new Promise((r) => setTimeout(r, fp.emitDelayMs));
        if (fp.emitFailFor.has(name)) throw new Error('emit refused');
        fp.emitted.push({ name, payload: payload as Record<string, unknown> });
        return { ok: true };
      },
      files: {
        async putStream(key, body) {
          let bytes: Uint8Array;
          if (body instanceof Uint8Array) bytes = body;
          else if (typeof body === 'string') bytes = new TextEncoder().encode(body);
          else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
          else bytes = new Uint8Array(await new Response(body).arrayBuffer());
          fp.staged.set(key, bytes);
          return { ok: true, key };
        },
        async extract(input) {
          fp.extractCalls.push({ ...input });
          const bytes = fp.staged.get(input.file_key);
          if (!bytes) return { ok: false, error: 'not_found' };
          return fp.extractAnswer(input.format ?? '', new TextDecoder().decode(bytes), input.job_token);
        },
        async job(token) {
          return fp.jobs.get(token) ?? { status: 'not_found' };
        },
        async delete(key) {
          fp.stagedDeletes.push(key);
          fp.staged.delete(key);
          return { ok: true };
        },
      },
      acl: {
        async linkIdentity(owner, email) {
          fp.links.push({ op: 'link', owner, email });
        },
        async unlinkIdentity(owner, email) {
          fp.links.push({ op: 'unlink', owner, ...(email ? { email } : {}) });
        },
      },
    },
  };
  return fp;
}

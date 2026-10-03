/**
 * A fake cloud drive plus three adapters over it, one per real shape:
 *   - driveAdapter:   google-workspace (files.list full walk with its own
 *                     continuation + changes feed, permissions inline,
 *                     install-scoped `gw:file:<id>` objectIDs);
 *   - deltaAdapter:   microsoft-365 (one delta feed for both, the walk's
 *                     continuation is the cursor, permissions in a separate
 *                     batch that can fail, `ms:file:<actorKey>:<drive>:<id>`);
 *   - dropboxAdapter: dropbox (files/list_folder + list_folder/continue, a
 *                     409 `reset`, principals from sharing/list_file_members
 *                     with a per-shared-folder cache).
 */
import { groupPrincipal, userPrincipal } from '../../src/doc-acl';
import type {
  ChangePage,
  FileIndexingContext,
  FileSourceAdapter,
  IndexedFileObject,
  ResolvedPrincipals,
} from '../../src/types';

export interface FakeFile {
  id: string;
  name: string;
  mime: string;
  size?: number;
  content?: string;
  folder?: boolean;
  /** Emails (or `group:<id>`) granted. `undefined` = the source hides the ACL. */
  perms?: string[];
  /** A sharing link exists (anyone / org): must stamp NOTHING. */
  link?: boolean;
  createdAt?: string;
  modifiedAt?: string;
  driveId?: string;
  sharedFolderId?: string;
}

export class FakeSource {
  files = new Map<string, FakeFile>();
  log: Array<{ id: string; removed: boolean }> = [];
  /** Ids whose permission read fails this call (transient). */
  failPerms = new Set<string>();
  /** Shared-folder member lists (dropbox). */
  sharedFolders = new Map<string, string[]>();
  sharedFolderCalls = 0;
  pageSize = 2;
  /** Dropbox: the next continue answers 409 reset. */
  resetNext = false;
  binary = new Map<string, Uint8Array>();

  put(f: FakeFile): void {
    const now = '2026-10-01T00:00:00Z';
    this.files.set(f.id, { createdAt: now, modifiedAt: now, ...f });
    this.log.push({ id: f.id, removed: false });
  }
  touch(id: string, patch: Partial<FakeFile>): void {
    const f = this.files.get(id)!;
    this.files.set(id, { ...f, ...patch, modifiedAt: patch.modifiedAt ?? '2026-10-02T00:00:00Z' });
    this.log.push({ id, removed: false });
  }
  remove(id: string): void {
    this.files.delete(id);
    this.log.push({ id, removed: true });
  }
  ids(): string[] {
    return [...this.files.keys()].sort();
  }
  listPage(offset: number): { entries: FakeFile[]; next: number | null } {
    const ids = this.ids();
    const slice = ids.slice(offset, offset + this.pageSize).map((id) => this.files.get(id)!);
    const end = offset + this.pageSize;
    return { entries: slice, next: end < ids.length ? end : null };
  }
  changesPage(pos: number, idPrefix: (id: string) => string, removedExtra: (id: string) => Record<string, unknown>) {
    const slice = this.log.slice(pos, pos + this.pageSize);
    const entries: FakeFile[] = [];
    const removed: Array<{ objectID: string; [k: string]: unknown }> = [];
    for (const c of slice) {
      const f = this.files.get(c.id);
      if (c.removed || !f) removed.push({ objectID: idPrefix(c.id), ...removedExtra(c.id) });
      else entries.push(f);
    }
    const end = pos + this.pageSize;
    return { entries, removed, hasMore: end < this.log.length, end };
  }
}

function baseObject(f: FakeFile, objectID: string, principals: string[], source: string, extra: Record<string, unknown>): IndexedFileObject {
  return {
    objectID,
    acl_principals: principals,
    name: f.name,
    path: '/',
    mimeType: f.folder ? 'folder' : f.mime,
    isFolder: f.folder ? 'true' : 'false',
    size: f.size ?? 0,
    webUrl: `https://example.test/${f.id}`,
    driveId: f.driveId ?? 'drive-1',
    source,
    createdAt: f.createdAt ?? '',
    modifiedAt: f.modifiedAt ?? '',
    createdBy: '',
    modifiedBy: '',
    content: '',
    _keywords: f.name,
    ...extra,
  };
}

function inlinePrincipals(f: FakeFile, src: FakeSource, ctx: FileIndexingContext): ResolvedPrincipals {
  if (src.failPerms.has(f.id)) return 'unresolved';
  if (f.perms === undefined) return 'denied';
  const out = new Set<string>();
  if (ctx.ownerEmail) out.add(userPrincipal(ctx.ownerEmail));
  for (const p of f.perms) out.add(p.startsWith('group:') ? groupPrincipal(p.slice(6)) : userPrincipal(p));
  // f.link: a sharing link confers no search visibility, so nothing is added.
  return [...out];
}

function content(src: FakeSource) {
  return {
    async downloadText(o: IndexedFileObject) {
      const f = src.files.get(String(o.fileId ?? o.itemId));
      return f?.content ?? '';
    },
    async downloadBinary(o: IndexedFileObject) {
      const bytes = src.binary.get(String(o.fileId ?? o.itemId)) ?? new Uint8Array();
      return new Response(bytes as unknown as ArrayBuffer, { headers: { 'content-length': String(bytes.byteLength) } });
    },
  };
}

/** google-workspace shape. */
export function driveAdapter(src: FakeSource): FileSourceAdapter<FakeFile> {
  const oid = (id: string) => `gw:file:${id}`;
  return {
    logLabel: '[file-indexing]',
    eventPrefix: 'google',
    eventIdField: 'fileId',
    objectIdsActorScoped: false,
    cursorResetDetail: 'page_token_expired_reset',
    objectIdPrefix: () => 'gw:file:',
    async seedCursor() {
      return `chg:${src.log.length}`;
    },
    async fullWalk(token): Promise<ChangePage<FakeFile>> {
      if (token === 'list:STALE') return { entries: [], cursor: null, hasMore: false, restartWalk: true };
      const offset = token ? Number(token.slice('list:'.length)) : 0;
      const page = src.listPage(offset);
      return { entries: page.entries, cursor: page.next !== null ? `list:${page.next}` : null, hasMore: page.next !== null };
    },
    async listChanges(cursor): Promise<ChangePage<FakeFile>> {
      if (cursor === 'chg:EXPIRED') return { entries: [], cursor: null, hasMore: false, reset: true };
      const p = src.changesPage(Number(cursor.slice('chg:'.length)), oid, (id) => ({ fileId: id }));
      return {
        entries: p.entries,
        removed: p.removed,
        cursor: p.hasMore ? `chg:${p.end}` : `chg:${src.log.length}`,
        hasMore: p.hasMore,
      };
    },
    async resolvePrincipals(entries, ctx) {
      return new Map(entries.map((f) => [oid(f.id), inlinePrincipals(f, src, ctx)]));
    },
    objectIdOf: (f) => oid(f.id),
    toObject: (f, principals) => baseObject(f, oid(f.id), principals, 'google-drive', { fileId: f.id }),
    mimeTypeOf: (f) => f.mime,
    isNativeExportable: (m) => m === 'application/vnd.google-apps.document',
    async exportNative(o) {
      return `exported:${src.files.get(String(o.fileId))?.content ?? ''}`;
    },
    ...content(src),
  };
}

/** microsoft-365 shape (delta: the full walk is the delta from nothing). */
export function deltaAdapter(src: FakeSource): FileSourceAdapter<FakeFile> {
  const oid = (ctx: FileIndexingContext, f: { id: string; driveId?: string }) =>
    `ms:file:${ctx.key}:${f.driveId ?? 'drive-1'}:${f.id}`;
  const delta = async (token: string | null, ctx: FileIndexingContext): Promise<ChangePage<FakeFile>> => {
    if (token === 'delta:EXPIRED') return { entries: [], cursor: null, hasMore: false, reset: true };
    if (token === null || token.startsWith('full:')) {
      const offset = token ? Number(token.slice(5)) : 0;
      const page = src.listPage(offset);
      return page.next !== null
        ? { entries: page.entries, cursor: `full:${page.next}`, hasMore: true }
        : { entries: page.entries, cursor: `delta:${src.log.length}`, hasMore: false };
    }
    const p = src.changesPage(
      Number(token.slice('delta:'.length)),
      (id) => `ms:file:${ctx.key}:drive-1:${id}`,
      (id) => ({ itemId: id, driveId: 'drive-1' }),
    );
    return { entries: p.entries, removed: p.removed, cursor: `delta:${p.hasMore ? p.end : src.log.length}`, hasMore: p.hasMore };
  };
  return {
    logLabel: '[ms-file-indexing]',
    eventPrefix: 'microsoft365',
    eventIdField: 'itemId',
    objectIdsActorScoped: true,
    cursorResetDetail: 'delta_token_expired_reset',
    objectIdPrefix: (ctx) => `ms:file:${ctx.key}:`,
    reconcilePrefixes(seen, ctx) {
      const pre = `ms:file:${ctx.key}:`;
      const drives = new Set(seen.filter((s) => s.startsWith(pre)).map((s) => s.slice(pre.length).split(':')[0]!));
      return [...drives].map((d) => `${pre}${d}:`);
    },
    plainIndexSweepPrefix: () => 'ms:file:',
    fullWalk: delta,
    listChanges: (c, ctx) => delta(c, ctx),
    async resolvePrincipals(entries, ctx) {
      // The $batch: a failed sub-request leaves the item ABSENT.
      const out = new Map<string, ResolvedPrincipals>();
      for (const f of entries) {
        if (src.failPerms.has(f.id)) continue;
        out.set(oid(ctx, f), inlinePrincipals(f, src, ctx));
      }
      return out;
    },
    objectIdOf: (f, ctx) => oid(ctx, f),
    toObject: (f, principals, ctx) =>
      baseObject(f, oid(ctx, f), principals, f.driveId?.startsWith('sp-') ? 'sharepoint' : 'onedrive', { itemId: f.id }),
    emitsEventsFor: (o) => o.source === 'onedrive',
    aclRefreshPage: async (link, ctx) => {
      const offset = link ? Number(link) : 0;
      const page = src.listPage(offset);
      void ctx;
      return { entries: page.entries, cursor: page.next !== null ? String(page.next) : null, hasMore: page.next !== null };
    },
    ...content(src),
  };
}

/** dropbox shape: list_folder(recursive) + list_folder/continue. */
export function dropboxAdapter(src: FakeSource): FileSourceAdapter<FakeFile> {
  const oid = (ctx: FileIndexingContext, id: string) => `dbx:file:${ctx.key}:${id}`;
  const listFolder = async (cursor: string | null, ctx: FileIndexingContext): Promise<ChangePage<FakeFile>> => {
    if (cursor !== null && src.resetNext) {
      src.resetNext = false;
      // list_folder/continue answered 409 { error: { '.tag': 'reset' } }.
      return { entries: [], cursor: null, hasMore: false, reset: true };
    }
    if (cursor === null || cursor.startsWith('dbx:walk:')) {
      const offset = cursor ? Number(cursor.slice('dbx:walk:'.length)) : 0;
      const page = src.listPage(offset);
      return page.next !== null
        ? { entries: page.entries, cursor: `dbx:walk:${page.next}`, hasMore: true }
        : { entries: page.entries, cursor: `dbx:chg:${src.log.length}`, hasMore: false };
    }
    const p = src.changesPage(Number(cursor.slice('dbx:chg:'.length)), (id) => oid(ctx, id), (id) => ({ fileId: id }));
    return { entries: p.entries, removed: p.removed, cursor: `dbx:chg:${p.hasMore ? p.end : src.log.length}`, hasMore: p.hasMore };
  };
  return {
    logLabel: '[dropbox-file-indexing]',
    eventPrefix: 'dropbox',
    eventIdField: 'fileId',
    objectIdsActorScoped: true,
    cursorResetDetail: 'list_folder_cursor_reset',
    objectIdPrefix: (ctx) => `dbx:file:${ctx.key}:`,
    fullWalk: listFolder,
    listChanges: (c, ctx) => listFolder(c, ctx),
    async resolvePrincipals(entries, ctx) {
      // sharing/list_file_members, cached per shared folder for this call:
      // every file in one shared folder inherits the same member list.
      const cache = new Map<string, string[]>();
      const out = new Map<string, ResolvedPrincipals>();
      for (const f of entries) {
        if (src.failPerms.has(f.id)) {
          out.set(oid(ctx, f.id), 'unresolved');
          continue;
        }
        const principals = new Set<string>();
        if (ctx.ownerEmail) principals.add(userPrincipal(ctx.ownerEmail));
        if (f.sharedFolderId) {
          let members = cache.get(f.sharedFolderId);
          if (!members) {
            src.sharedFolderCalls++;
            members = src.sharedFolders.get(f.sharedFolderId) ?? [];
            cache.set(f.sharedFolderId, members);
          }
          for (const m of members) principals.add(userPrincipal(m));
        }
        for (const p of f.perms ?? []) principals.add(userPrincipal(p));
        out.set(oid(ctx, f.id), [...principals]);
      }
      return out;
    },
    objectIdOf: (f, ctx) => oid(ctx, f.id),
    toObject: (f, principals, ctx) => baseObject(f, oid(ctx, f.id), principals, 'dropbox', { fileId: f.id }),
    ...content(src),
  };
}

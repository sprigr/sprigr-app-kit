import {
  createD1FileIndexingStore,
  DEFAULT_FILE_INDEXING_SCHEMA_SQL,
  GOOGLE_WORKSPACE_STORE_CONFIG,
  MICROSOFT_365_STORE_CONFIG,
} from '../../src/d1-store';
import type { FileIndexingScope, FileIndexingStore, FileSourceAdapter } from '../../src/types';
import { makeFakePlatform, type FakePlatform } from './fake-env';
import { FakeSource, deltaAdapter, driveAdapter, dropboxAdapter, type FakeFile } from './fake-source';
import { GOOGLE_WORKSPACE_SCHEMA, HELD_SINCE_MIGRATION, MICROSOFT_365_SCHEMA } from './schemas';
import { makeSqliteD1, type SqliteD1 } from './sqlite-d1';

export interface Rig {
  db: SqliteD1;
  store: FileIndexingStore;
  fp: FakePlatform;
  src: FakeSource;
  adapter: FileSourceAdapter<FakeFile>;
  scope: FileIndexingScope;
  table: string;
}

export const ALICE = { platformUserId: 'user_alice' };
export const BOB = { platformUserId: 'user_bob' };

export async function rig(
  kind: 'drive' | 'delta' | 'dropbox',
  opts: { heldSince?: boolean; platform?: Parameters<typeof makeFakePlatform>[0] } = {},
): Promise<Rig> {
  const fp = makeFakePlatform(opts.platform);
  const src = new FakeSource();
  if (kind === 'drive') {
    const db = await makeSqliteD1(GOOGLE_WORKSPACE_SCHEMA + (opts.heldSince ? HELD_SINCE_MIGRATION('gw_file_indexing') : ''));
    const store = createD1FileIndexingStore(db, {
      ...GOOGLE_WORKSPACE_STORE_CONFIG,
      ...(opts.heldSince ? { heldSinceColumn: 'unresolved_held_since' } : {}),
    });
    const scope = { actor: ALICE };
    await store.enable(scope, { connectedEmail: 'Alice@Corp.com' });
    return { db, store, fp, src, adapter: driveAdapter(src), scope, table: 'gw_file_indexing' };
  }
  if (kind === 'dropbox') {
    // A new app: the package's default tables and config, nothing passed.
    const db = await makeSqliteD1(DEFAULT_FILE_INDEXING_SCHEMA_SQL);
    const store = createD1FileIndexingStore(db);
    const scope = { actor: ALICE, connectionId: 'dbx-acct-1' };
    await store.enable(scope, { connectedEmail: 'alice@corp.com' });
    return { db, store, fp, src, adapter: dropboxAdapter(src), scope, table: 'file_indexing' };
  }
  const db = await makeSqliteD1(MICROSOFT_365_SCHEMA + (opts.heldSince ? HELD_SINCE_MIGRATION('ms_file_indexing') : ''));
  const store = createD1FileIndexingStore(db, {
    ...MICROSOFT_365_STORE_CONFIG,
    walkKey: (s) => `c-${s.connectionId}/${s.actor.platformUserId ?? s.actor.agentId}`,
    ...(opts.heldSince ? { heldSinceColumn: 'unresolved_held_since' } : {}),
  });
  const scope = { actor: ALICE, connectionId: 'conn-1' };
  await store.enable(scope, { connectedEmail: 'alice@corp.com', extra: { tenant_id: 'tenant-1' } });
  return { db, store, fp, src, adapter: deltaAdapter(src), scope, table: 'ms_file_indexing' };
}

export function seedFiles(src: FakeSource, n: number, perms: string[] = ['bob@corp.com']): void {
  for (let i = 1; i <= n; i++) {
    src.put({ id: `f${String(i).padStart(2, '0')}`, name: `file ${i}.txt`, mime: 'text/plain', content: `body ${i}`, perms });
  }
}

/** A clock the tests move by hand. */
export function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  return { now, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

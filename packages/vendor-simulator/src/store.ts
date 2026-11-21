import {
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type OverlayRow,
  type SampleObject,
  type SampleStore,
} from './types';

export interface SampleStoreOptions {
  db: D1Database;
  /** The app's own table, created by its migration (see README). */
  table: string;
}

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface OverlayDbRow {
  id: string;
  body: string;
  deleted: number;
}

/** One install's flag and overlay, in the app's per-install D1. */
export function createSampleStore({ db, table }: SampleStoreOptions): SampleStore {
  // The name is interpolated into SQL, so only a plain identifier is accepted.
  if (!PLAIN_IDENTIFIER.test(table)) {
    throw new TypeError(`vendor-simulator: table must be a plain identifier, got ${JSON.stringify(table)}`);
  }
  const upsert = `INSERT INTO ${table} (resource, id, body, deleted) VALUES (?, ?, ?, ?) ON CONFLICT(resource, id)`;

  const appResource = (resource: string): string => {
    if (resource === SAMPLE_FLAG_RESOURCE) {
      throw new TypeError(`vendor-simulator: ${SAMPLE_FLAG_RESOURCE} is reserved for the sample flag`);
    }
    return resource;
  };

  return {
    async isOn(): Promise<boolean> {
      const row = await db
        .prepare(`SELECT id FROM ${table} WHERE resource = ? AND id = ?`)
        .bind(SAMPLE_FLAG_RESOURCE, SAMPLE_FLAG_ID)
        .first<{ id: string }>();
      return row !== null;
    },

    async setOn(): Promise<void> {
      await db.prepare(`${upsert} DO NOTHING`).bind(SAMPLE_FLAG_RESOURCE, SAMPLE_FLAG_ID, '{}', 0).run();
    },

    async listOverlay(resource: string): Promise<OverlayRow[]> {
      const { results } = await db
        .prepare(`SELECT id, body, deleted FROM ${table} WHERE resource = ?`)
        .bind(appResource(resource))
        .all<OverlayDbRow>();
      return results.map((r) => ({ id: String(r.id), body: String(r.body), deleted: Number(r.deleted) === 1 }));
    },

    async put(resource: string, id: string, body: SampleObject | null): Promise<void> {
      await db
        .prepare(`${upsert} DO UPDATE SET body = excluded.body, deleted = excluded.deleted`)
        .bind(appResource(resource), id, body === null ? '{}' : JSON.stringify(body), body === null ? 1 : 0)
        .run();
    },

    async clear(): Promise<void> {
      await db.prepare(`DELETE FROM ${table}`).run();
    },
  };
}

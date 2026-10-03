/**
 * The D1 implementation of FileIndexingStore, parameterised by table and
 * column names so each app keeps its existing, immutable migrations.
 *
 * The two apps' schemas agree on most columns (sprigr_user_id,
 * sprigr_agent_id, enabled, connected_email, last_indexed_at, last_status,
 * last_error, files_indexed, files_skipped, full_walk_active, created_at,
 * updated_at, identity_link_refused_at) and differ on these, which the config
 * names:
 *
 *   google-workspace (gw_file_indexing)       microsoft-365 (ms_file_indexing)
 *   cursor     page_token                     delta_link
 *   scope      actor only                     actor + connection_id (0013,
 *                                              NOT NULL, part of the UNIQUE key)
 *   walk       walk_list_token,               (none: the walk's continuation
 *              walk_start_token (0012)         is the delta_link itself)
 *   refresh    (none)                         acl_refresh_link,
 *                                              acl_refresh_completed_at (0024)
 *   other      (none)                         tenant_id, sp_auto_drives,
 *                                              sp_auto_at, sp_walk_next (0016)
 *
 * The walk-seen and pending-extraction tables are identical in both apps.
 * App-only columns stay readable on `row.raw` and writable by the app's own
 * queries; `enable` takes `extra` values for them (microsoft-365's tenant_id).
 *
 * Actor matching follows both apps exactly: a bound user matches
 * `sprigr_user_id = ?`; an agent-only actor matches only agent rows
 * (`sprigr_agent_id = ? AND sprigr_user_id IS NULL`), so a shared agent can
 * never reach a user's personal state, and there is no reverse fallback.
 */

import { actorKey, type D1Like } from '@sprigr/apps-app-sdk';
import { actorOfFileRow } from './indexer';
import type { FileIndexingRow, FileIndexingScope, FileIndexingStore, PendingExtractionRow } from './types';

export interface D1FileIndexingStoreConfig {
  tables: {
    /** gw_file_indexing / ms_file_indexing */
    indexing: string;
    /** gw_walk_seen / ms_walk_seen */
    walkSeen: string;
    /** gw_pending_extractions / ms_pending_extractions */
    pendingExtractions: string;
  };
  /** page_token (google-workspace) / delta_link (microsoft-365). */
  cursorColumn: string;
  /** connection_id (microsoft-365). A scope with a connectionId needs it. */
  connectionColumn?: string;
  /** google-workspace 0012: the full walk's listing continuation and baseline. */
  walkResumeColumns?: { listToken: string; startToken: string };
  /** Optional INTEGER column bounding the unresolved-permissions cursor hold
   *  (sprigr-apps#2419). Neither app has it yet; add it in the migration PR. */
  heldSinceColumn?: string;
  /** microsoft-365 0024: the permission re-stamp's continuation and completion. */
  aclRefreshColumns?: { link: string; completedAt: string };
  /** Column holding the identity-link refusal time (default identity_link_refused_at). */
  identityLinkRefusedColumn?: string;
  /** google-workspace writes the agent id on user rows; microsoft-365 writes NULL
   *  there. Only affects `enable`. Default true. */
  storeAgentIdForUsers?: boolean;
  /** The seen-set key for a scope. Default: actorKey(actor), or
   *  `<connectionId>/<actorKey>` when the scope has a connection. microsoft-365
   *  passes its fileWalkKey so in-flight walks keep their seen sets. */
  walkKey?: (scope: FileIndexingScope) => string;
  /** Redact credential-shaped values from an error before it is stored.
   *  Default: a conservative built-in (bearer tokens, *_token / secret /
   *  password values). The apps pass their vendored redactSecrets. */
  redact?: (text: string) => string;
  now?: () => number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`createD1FileIndexingStore: ${what} "${name}" is not a plain SQL identifier`);
  return name;
}

/** Default redaction: bearer tokens and token/secret/password values. */
export function defaultRedact(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(
      /((?:access|refresh|id)_token|client_secret|secret|password|api_key|apikey)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      '$1$2[redacted]',
    );
}

/** Bound-parameter budget per walk-seen insert (3 per row, under D1's 100). */
const WALK_SEEN_INSERT_CHUNK = 30;
/** Ids per pending-row lookup or delete (one parameter each). */
const PENDING_LOOKUP_CHUNK = 90;

export function createD1FileIndexingStore(
  db: D1Like,
  config: D1FileIndexingStoreConfig = DEFAULT_FILE_INDEXING_STORE_CONFIG,
): FileIndexingStore {
  const T = ident(config.tables.indexing, 'tables.indexing');
  const SEEN = ident(config.tables.walkSeen, 'tables.walkSeen');
  const PENDING = ident(config.tables.pendingExtractions, 'tables.pendingExtractions');
  const CURSOR = ident(config.cursorColumn, 'cursorColumn');
  const CONN = config.connectionColumn ? ident(config.connectionColumn, 'connectionColumn') : null;
  const LIST = config.walkResumeColumns ? ident(config.walkResumeColumns.listToken, 'walkResumeColumns.listToken') : null;
  const START = config.walkResumeColumns ? ident(config.walkResumeColumns.startToken, 'walkResumeColumns.startToken') : null;
  const HELD = config.heldSinceColumn ? ident(config.heldSinceColumn, 'heldSinceColumn') : null;
  const REFRESH_LINK = config.aclRefreshColumns ? ident(config.aclRefreshColumns.link, 'aclRefreshColumns.link') : null;
  const REFRESH_DONE = config.aclRefreshColumns
    ? ident(config.aclRefreshColumns.completedAt, 'aclRefreshColumns.completedAt')
    : null;
  const REFUSED = ident(config.identityLinkRefusedColumn ?? 'identity_link_refused_at', 'identityLinkRefusedColumn');
  const redact = config.redact ?? defaultRedact;
  const clock = config.now ?? Date.now;
  const storeAgentIdForUsers = config.storeAgentIdForUsers !== false;

  function actorWhere(scope: FileIndexingScope): { where: string; binds: unknown[] } | null {
    if (scope.actor.platformUserId) return { where: 'sprigr_user_id = ?', binds: [scope.actor.platformUserId] };
    if (scope.actor.agentId) {
      return { where: 'sprigr_agent_id = ? AND sprigr_user_id IS NULL', binds: [scope.actor.agentId] };
    }
    return null;
  }

  function scopeWhere(scope: FileIndexingScope): { where: string; binds: unknown[] } | null {
    const a = actorWhere(scope);
    if (!a) return null;
    if (scope.connectionId !== undefined) {
      if (!CONN) throw new Error('file-indexing store: scope has a connectionId but the store has no connectionColumn');
      return { where: `${a.where} AND ${CONN} = ?`, binds: [...a.binds, scope.connectionId] };
    }
    if (CONN) throw new Error('file-indexing store: this store is per connection; the scope needs a connectionId');
    return a;
  }

  function toRow(raw: Record<string, unknown>): FileIndexingRow {
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return {
      enabled: num(raw.enabled) ?? 0,
      cursor: str(raw[CURSOR]),
      connected_email: str(raw.connected_email),
      full_walk_active: num(raw.full_walk_active) ?? 0,
      walk_list_token: LIST ? str(raw[LIST]) : null,
      walk_start_token: START ? str(raw[START]) : null,
      identity_link_refused_at: num(raw[REFUSED]),
      unresolved_held_since: HELD ? num(raw[HELD]) : null,
      acl_refresh_link: REFRESH_LINK ? str(raw[REFRESH_LINK]) : null,
      acl_refresh_completed_at: REFRESH_DONE ? num(raw[REFRESH_DONE]) : null,
      last_indexed_at: num(raw.last_indexed_at),
      last_status: str(raw.last_status),
      last_error: str(raw.last_error),
      files_indexed: num(raw.files_indexed) ?? 0,
      files_skipped: num(raw.files_skipped) ?? 0,
      raw,
    };
  }

  async function update(scope: FileIndexingScope, set: string, binds: unknown[]): Promise<void> {
    const s = scopeWhere(scope);
    if (!s) return;
    await db
      .prepare(`UPDATE ${T} SET ${set}, updated_at = ? WHERE ${s.where}`)
      .bind(...binds, clock(), ...s.binds)
      .run();
  }

  const walkReset = LIST && START ? `, ${LIST} = NULL, ${START} = NULL` : '';

  const store: FileIndexingStore = {
    hasWalkResumeColumns: !!(LIST && START),
    hasHeldSinceColumn: !!HELD,
    hasAclRefreshColumns: !!(REFRESH_LINK && REFRESH_DONE),

    walkKey(scope) {
      if (config.walkKey) return config.walkKey(scope);
      const base = actorKey(scope.actor) ?? '';
      if (!base) return '';
      return scope.connectionId !== undefined ? `${scope.connectionId}/${base}` : base;
    },

    async load(scope) {
      const s = scopeWhere(scope);
      if (!s) return null;
      const raw = await db
        .prepare(`SELECT * FROM ${T} WHERE ${s.where} LIMIT 1`)
        .bind(...s.binds)
        .first<Record<string, unknown>>();
      return raw ? toRow(raw) : null;
    },

    async listEnabled() {
      // Stale-first, so a tick that defers its tail starts there next time.
      const res = await db
        .prepare(`SELECT * FROM ${T} WHERE enabled = 1 ORDER BY last_indexed_at ASC`)
        .all<Record<string, unknown>>();
      return res.results.map((raw) => {
        const actor = actorOfFileRow(raw);
        const connectionId = CONN && typeof raw[CONN] === 'string' ? (raw[CONN] as string) : undefined;
        return { scope: { actor, ...(connectionId !== undefined ? { connectionId } : {}) }, row: toRow(raw) };
      });
    },

    async enable(scope, opts) {
      const extra = opts.extra ?? {};
      for (const k of Object.keys(extra)) ident(k, 'enable extra column');
      await store.remove(scope);
      const now = clock();
      const user = scope.actor.platformUserId ?? null;
      const agent = user && !storeAgentIdForUsers ? null : (scope.actor.agentId ?? null);
      const cols = [
        'sprigr_user_id',
        'sprigr_agent_id',
        'enabled',
        CURSOR,
        'connected_email',
        'last_indexed_at',
        'last_status',
        'last_error',
        'files_indexed',
        'files_skipped',
        'full_walk_active',
        'created_at',
        'updated_at',
      ];
      const binds: unknown[] = [user, agent, 1, null, opts.connectedEmail, null, null, null, 0, 0, 0, now, now];
      if (scope.connectionId !== undefined) {
        if (!CONN) throw new Error('file-indexing store: scope has a connectionId but the store has no connectionColumn');
        cols.push(CONN);
        binds.push(scope.connectionId);
      }
      for (const [k, v] of Object.entries(extra)) {
        cols.push(k);
        binds.push(v);
      }
      await db
        .prepare(`INSERT INTO ${T} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...binds)
        .run();
    },

    async disable(scope) {
      const row = await store.load(scope);
      if (!row) return false;
      await update(scope, 'enabled = 0', []);
      return true;
    },

    async remove(scope) {
      const s = scopeWhere(scope);
      if (!s) return;
      await db.prepare(`DELETE FROM ${T} WHERE ${s.where}`).bind(...s.binds).run();
    },

    async countOtherActors(scope) {
      const total = await db.prepare(`SELECT COUNT(*) AS n FROM ${T}`).first<{ n: number }>();
      const a = actorWhere(scope);
      if (!a) return total?.n ?? 0;
      const mine = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE ${a.where}`)
        .bind(...a.binds)
        .first<{ n: number }>();
      return (total?.n ?? 0) - (mine?.n ?? 0);
    },

    async recordSuccess(scope, cursor, indexed, skipped) {
      await update(
        scope,
        `${CURSOR} = ?${walkReset}, last_indexed_at = ?, last_status = 'ok', last_error = NULL, ` +
          `files_indexed = files_indexed + ?, files_skipped = files_skipped + ?`,
        [cursor, clock(), indexed, skipped],
      );
    },

    async recordWalkProgress(scope, progress) {
      if (!LIST || !START) throw new Error('file-indexing store: recordWalkProgress needs walkResumeColumns');
      await update(
        scope,
        `${LIST} = ?, ${START} = ?, last_indexed_at = ?, last_status = 'ok', last_error = NULL, ` +
          `files_indexed = files_indexed + ?, files_skipped = files_skipped + ?`,
        [progress.listToken, progress.startToken, clock(), progress.indexed, progress.skipped],
      );
    },

    async recordError(scope, error) {
      await update(scope, `last_indexed_at = ?, last_status = 'error', last_error = ?`, [
        clock(),
        redact(error).slice(0, 500),
      ]);
    },

    async resetCursor(scope) {
      await update(scope, `${CURSOR} = NULL${walkReset}`, []);
    },

    async setIdentityLinkRefused(scope, refusedAt) {
      await update(scope, `${REFUSED} = ?`, [refusedAt]);
    },

    async setConnectedEmail(scope, email) {
      await update(scope, 'connected_email = ?', [email]);
    },

    async setFullWalkActive(scope, active) {
      await update(scope, 'full_walk_active = ?', [active ? 1 : 0]);
    },

    async setUnresolvedHeldSince(scope, since) {
      if (!HELD) return;
      await update(scope, `${HELD} = ?`, [since]);
    },

    async setAclRefresh(scope, link, completedAt) {
      if (!REFRESH_LINK || !REFRESH_DONE) throw new Error('file-indexing store: setAclRefresh needs aclRefreshColumns');
      await update(scope, `${REFRESH_LINK} = ?, ${REFRESH_DONE} = ?`, [link, completedAt]);
    },

    async recordWalkSeen(walkKey, objectIds) {
      if (objectIds.length === 0) return;
      const now = clock();
      for (let i = 0; i < objectIds.length; i += WALK_SEEN_INSERT_CHUNK) {
        const chunk = objectIds.slice(i, i + WALK_SEEN_INSERT_CHUNK);
        const binds: unknown[] = [];
        for (const id of chunk) binds.push(walkKey, id, now);
        await db
          .prepare(
            `INSERT OR REPLACE INTO ${SEEN} (actor_key, object_id, created_at) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
          )
          .bind(...binds)
          .run();
      }
    },

    async listWalkSeen(walkKey) {
      const res = await db
        .prepare(`SELECT object_id FROM ${SEEN} WHERE actor_key = ?`)
        .bind(walkKey)
        .all<{ object_id: string }>();
      return res.results.map((r) => r.object_id);
    },

    async clearWalkSeen(walkKey) {
      await db.prepare(`DELETE FROM ${SEEN} WHERE actor_key = ?`).bind(walkKey).run();
    },

    async upsertPendingExtraction(row) {
      const now = clock();
      await db
        .prepare(
          `INSERT INTO ${PENDING} (object_id, job_token, record_json, format, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(object_id) DO UPDATE SET
             job_token = excluded.job_token,
             record_json = excluded.record_json,
             format = excluded.format,
             attempts = 0,
             updated_at = excluded.updated_at`,
        )
        .bind(row.objectId, row.jobToken, row.recordJson, row.format, now, now)
        .run();
    },

    async listPendingExtractions(limit) {
      const res = await db
        .prepare(`SELECT * FROM ${PENDING} ORDER BY created_at ASC LIMIT ?`)
        .bind(limit)
        .all<PendingExtractionRow>();
      return res.results;
    },

    async listPendingExtractionsFor(objectIds) {
      const out: Array<Pick<PendingExtractionRow, 'object_id' | 'record_json'>> = [];
      for (let i = 0; i < objectIds.length; i += PENDING_LOOKUP_CHUNK) {
        const chunk = objectIds.slice(i, i + PENDING_LOOKUP_CHUNK);
        const res = await db
          .prepare(`SELECT object_id, record_json FROM ${PENDING} WHERE object_id IN (${chunk.map(() => '?').join(', ')})`)
          .bind(...chunk)
          .all<Pick<PendingExtractionRow, 'object_id' | 'record_json'>>();
        out.push(...res.results);
      }
      return out;
    },

    async refreshPendingExtractionRecord(objectId, recordJson) {
      await db
        .prepare(`UPDATE ${PENDING} SET record_json = ?, updated_at = ? WHERE object_id = ?`)
        .bind(recordJson, clock(), objectId)
        .run();
    },

    async bumpPendingExtraction(objectId) {
      await db
        .prepare(`UPDATE ${PENDING} SET attempts = attempts + 1, updated_at = ? WHERE object_id = ?`)
        .bind(clock(), objectId)
        .run();
    },

    async deletePendingExtraction(objectId) {
      await db.prepare(`DELETE FROM ${PENDING} WHERE object_id = ?`).bind(objectId).run();
    },

    async deletePendingExtractions(objectIds) {
      for (let i = 0; i < objectIds.length; i += PENDING_LOOKUP_CHUNK) {
        const chunk = objectIds.slice(i, i + PENDING_LOOKUP_CHUNK);
        await db
          .prepare(`DELETE FROM ${PENDING} WHERE object_id IN (${chunk.map(() => '?').join(', ')})`)
          .bind(...chunk)
          .run();
      }
    },
  };
  return store;
}

/** google-workspace's existing tables (migrations 0004, 0005, 0012, 0013). */
export const GOOGLE_WORKSPACE_STORE_CONFIG: Omit<D1FileIndexingStoreConfig, 'redact' | 'now'> = {
  tables: { indexing: 'gw_file_indexing', walkSeen: 'gw_walk_seen', pendingExtractions: 'gw_pending_extractions' },
  cursorColumn: 'page_token',
  walkResumeColumns: { listToken: 'walk_list_token', startToken: 'walk_start_token' },
  storeAgentIdForUsers: true,
};

/** microsoft-365's existing tables (migrations 0003, 0005, 0006, 0013, 0016, 0022, 0024).
 *  Pass `walkKey: (s) => fileWalkKey(s.actor, s.connectionId!)` alongside. */
export const MICROSOFT_365_STORE_CONFIG: Omit<D1FileIndexingStoreConfig, 'redact' | 'now' | 'walkKey'> = {
  tables: { indexing: 'ms_file_indexing', walkSeen: 'ms_walk_seen', pendingExtractions: 'ms_pending_extractions' },
  cursorColumn: 'delta_link',
  connectionColumn: 'connection_id',
  aclRefreshColumns: { link: 'acl_refresh_link', completedAt: 'acl_refresh_completed_at' },
  storeAgentIdForUsers: false,
};

/**
 * The package's own table names, for an app with no file-indexing tables yet
 * (dropbox). Per connection, with every optional column, so nothing has to be
 * added later. Create the tables with DEFAULT_FILE_INDEXING_SCHEMA_SQL in the
 * app's first file-indexing migration.
 */
export const DEFAULT_FILE_INDEXING_STORE_CONFIG: Omit<D1FileIndexingStoreConfig, 'redact' | 'now' | 'walkKey'> = {
  tables: { indexing: 'file_indexing', walkSeen: 'file_walk_seen', pendingExtractions: 'file_pending_extractions' },
  cursorColumn: 'cursor',
  connectionColumn: 'connection_id',
  heldSinceColumn: 'unresolved_held_since',
  aclRefreshColumns: { link: 'acl_refresh_link', completedAt: 'acl_refresh_completed_at' },
  storeAgentIdForUsers: false,
};

/** CREATE statements for DEFAULT_FILE_INDEXING_STORE_CONFIG. Copy into a
 *  migration file (migrations are immutable once published, so the app owns
 *  its copy). */
export const DEFAULT_FILE_INDEXING_SCHEMA_SQL = `CREATE TABLE file_indexing (
  sprigr_user_id           TEXT,
  sprigr_agent_id          TEXT,
  connection_id            TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 0,
  cursor                   TEXT,
  connected_email          TEXT,
  last_indexed_at          INTEGER,
  last_status              TEXT,
  last_error               TEXT,
  files_indexed            INTEGER NOT NULL DEFAULT 0,
  files_skipped            INTEGER NOT NULL DEFAULT 0,
  full_walk_active         INTEGER NOT NULL DEFAULT 0,
  identity_link_refused_at INTEGER,
  unresolved_held_since    INTEGER,
  acl_refresh_link         TEXT,
  acl_refresh_completed_at INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE (sprigr_user_id, sprigr_agent_id, connection_id)
);
CREATE INDEX idx_file_indexing_enabled ON file_indexing(enabled);
CREATE TABLE file_walk_seen (
  actor_key  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_key, object_id)
);
CREATE TABLE file_pending_extractions (
  object_id   TEXT PRIMARY KEY,
  job_token   TEXT NOT NULL,
  record_json TEXT NOT NULL,
  format      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_file_pending_extractions_created ON file_pending_extractions(created_at);
`;

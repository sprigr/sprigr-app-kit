/**
 * Before-image storage for the platform undo layer (sprigr-team decision 0011).
 *
 * THE SPLIT. The platform mints and owns the undo TOKEN, its TTL, its
 * actor/company scope and its single-use claim. This package owns the captured
 * copy of the object, which the platform deliberately never holds, because a
 * before-image of a deleted customer is their email, address and phone and the
 * shared registry must not become the custodian of tenant data it cannot
 * interpret.
 *
 * Consequence worth stating: this table needs no actor column and no scope
 * check. The only way to reach a row is to present a `ref` the platform has
 * already authorised by resolving its own token first. A second scope check
 * here would not make it safer, only inconsistent.
 *
 * WHAT THIS PACKAGE DOES NOT DO, on purpose. It does not know how to read or
 * rebuild your objects. Decision 0011 kept replay app-side because simPRO
 * needed four post-ship fixes that were all quirks of one vendor's write
 * schema. Capture and replay stay yours; the bookkeeping is here.
 */

import type {
  CaptureArgs,
  CapturedBefore,
  D1Like,
  JournalRow,
  UndoJournalOptions,
} from './types';

/** Matches the platform's token TTL. The platform's is authoritative for
 *  redemption; ours only decides when the bytes are dropped. */
export const DEFAULT_TTL_MS = 7 * 86_400_000;

/** Default ceiling on a stored before-image. */
export const DEFAULT_MAX_BEFORE_JSON = 400_000;

/**
 * SQLite identifiers cannot be bound as parameters, so the table name is
 * interpolated. Validate it hard rather than trusting the caller: this is the
 * one string in the package that reaches SQL unescaped.
 */
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function randomRef(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `cap_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The canonical DDL for an app's before-image table. Copy the output into a
 * real `.sql` migration in your app — app migrations are literal files, are
 * immutable once shipped, and are CI-checked, so this returns the text rather
 * than running it.
 */
export function undoJournalSchemaSql(table: string): string {
  assertTable(table);
  return `-- Before-image journal for the platform undo layer (decision 0011).
-- Schema owned by @sprigr/apps-undo-journal; regenerate with
-- undoJournalSchemaSql('${table}') if it ever changes.
--
-- The platform owns the undo token, its TTL, its actor/company scope and its
-- single-use claim. This table owns the captured copy of the object, which the
-- platform deliberately never holds. It therefore needs no actor column: the
-- only way to reach a row is to present a ref the platform already authorised.
CREATE TABLE IF NOT EXISTS ${table} (
  -- Our own handle, generated at CAPTURE time (before the write) and handed up
  -- in _undo.ref. The platform stores it beside the token it mints AFTERWARDS;
  -- the two moments cannot share an identifier, which is why both exist.
  ref TEXT PRIMARY KEY,

  -- Which registry entry knows how to rebuild this.
  entity TEXT NOT NULL,
  -- The id that was written over or deleted. Kept for the audit trail and the
  -- failure message.
  original_id TEXT NOT NULL,

  -- Which upstream connection the original write targeted, resolved at capture
  -- time. LOAD-BEARING for any multi-connection app: at redemption the platform
  -- dispatches fresh with no connection argument, so a replay falls through to
  -- the app's current default and rebuilds the object in the WRONG account,
  -- silently. Pinning back to this value is what stops that.
  connection TEXT,

  -- The captured object, JSON. Shaped by the entity's own capture, read back
  -- only by the same entity's replay.
  before_json TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  -- Our sweep horizon, set to match the platform's token TTL. If the two ever
  -- disagree the platform's is authoritative; ours only decides when the bytes
  -- are dropped.
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${table} (expires_at);
`;
}

function assertTable(table: string): void {
  if (!SAFE_TABLE.test(table)) {
    throw new Error(
      `@sprigr/apps-undo-journal: table name ${JSON.stringify(table)} is not a bare SQL identifier. ` +
        'It is interpolated into SQL, so it must match /^[A-Za-z_][A-Za-z0-9_]*$/.',
    );
  }
}

export interface UndoJournal {
  /**
   * Store a before-image and return the handle to put in `_undo.ref`.
   *
   * Returns null when the capture cannot be stored, and THE CALLER MUST TREAT
   * THAT AS "no undo offered" WHILE STILL DOING THE WRITE. A write that fails
   * because its safety net failed is a worse outcome than a write with no
   * safety net, and the user asked for the write. Equally, never return an
   * `_undo` envelope on a null: a token pointing at nothing is worse than no
   * token, because it invites the model to offer an undo that cannot work.
   *
   * NEVER TRUNCATES. A half-captured object replays as silent data loss: the
   * rebuild succeeds, looks complete, and is quietly missing fields. Over the
   * cap we store nothing and offer nothing, which is honest. The warning names
   * both lengths so the cap can be revisited with evidence.
   */
  captureBefore(args: CaptureArgs): Promise<CapturedBefore | null>;
  /** Read a stored before-image by the ref handed to the platform. Returns
   *  null for an unknown or already-dropped ref; the caller should surface
   *  that as a clear refusal rather than a crash. */
  loadBefore<T = unknown>(ref: string): Promise<JournalRow<T> | null>;
  /** Drop a before-image once it has been replayed. Best-effort. */
  dropBefore(ref: string): Promise<void>;
  /** Delete every expired row. Called opportunistically by captureBefore;
   *  exposed so an app can also run it from a scheduled handler. */
  sweepExpired(now?: number): Promise<void>;
}

export function createUndoJournal(options: UndoJournalOptions): UndoJournal {
  const { db, table, scope } = options;
  assertTable(table);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBeforeJson = options.maxBeforeJson ?? DEFAULT_MAX_BEFORE_JSON;
  const warn = (msg: string): void => {
    console.warn(`[${scope}] ${msg}`);
  };

  async function sweepExpired(now: number = Date.now()): Promise<void> {
    try {
      await db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).bind(now).run();
    } catch {
      // Housekeeping miss, not a user-visible problem. Rows age out next time.
    }
  }

  return {
    async captureBefore(args: CaptureArgs): Promise<CapturedBefore | null> {
      const where = `${args.entity} ${args.originalId}`;
      let payload: string;
      try {
        payload = JSON.stringify(args.before);
      } catch (err) {
        warn(`${where}: before-image is not serialisable: ${String(err)}. No undo will be offered.`);
        return null;
      }
      if (!payload || payload === 'null' || payload === '{}') {
        warn(`${where}: empty before-image, not capturing. No undo will be offered.`);
        return null;
      }
      if (payload.length > maxBeforeJson) {
        warn(
          `${where}: before-image is ${payload.length} chars, over the ${maxBeforeJson} cap. ` +
            'Not capturing, and NOT truncating: a partial capture would replay as a silently ' +
            'incomplete object. No undo will be offered for this write.',
        );
        return null;
      }

      const ref = randomRef();
      const now = Date.now();
      try {
        await db
          .prepare(
            `INSERT INTO ${table}
               (ref, entity, original_id, connection, before_json, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(ref, args.entity, args.originalId, args.connection, payload, now, now + ttlMs)
          .run();
      } catch (err) {
        warn(`${where}: journal insert failed: ${String(err)}. No undo will be offered.`);
        return null;
      }

      // Opportunistic; never blocks or fails the write.
      await sweepExpired(now);

      return { ref, entity: args.entity, originalId: args.originalId };
    },

    async loadBefore<T = unknown>(ref: string): Promise<JournalRow<T> | null> {
      let row: { entity: string; original_id: string; connection: string | null; before_json: string } | null;
      try {
        row = await db
          .prepare(`SELECT entity, original_id, connection, before_json FROM ${table} WHERE ref = ?`)
          .bind(ref)
          .first();
      } catch (err) {
        warn(`failed to load before-image ${ref}: ${String(err)}`);
        return null;
      }
      if (!row) return null;
      let before: T;
      try {
        before = JSON.parse(row.before_json) as T;
      } catch (err) {
        // A row we stored but cannot read back. Surface it rather than
        // returning a half-object the caller would replay.
        warn(`before-image ${ref} is stored but unparseable: ${String(err)}`);
        return null;
      }
      return { ...row, before };
    },

    async dropBefore(ref: string): Promise<void> {
      try {
        await db.prepare(`DELETE FROM ${table} WHERE ref = ?`).bind(ref).run();
      } catch (err) {
        // The platform has already marked its token spent, so this is only
        // about not keeping the data for the rest of the TTL after a restore.
        warn(`failed to drop before-image ${ref}: ${String(err)}`);
      }
    },

    sweepExpired,
  };
}

export type { CaptureArgs, CapturedBefore, D1Like, JournalRow, UndoJournalOptions };

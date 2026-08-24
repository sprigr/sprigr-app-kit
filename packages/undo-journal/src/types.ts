/**
 * D1 binding shape this package needs. Declared structurally so the package
 * stays self-contained when vendored, and matches the lowest common
 * denominator used by app-sdk and the rest of the @sprigr/apps packages, so a
 * caller can pass the same `env.DB` into all of them without TypeScript
 * fighting them on `run()` return types.
 */
export interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface D1PreparedStatementLike {
  bind(...args: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
}

/** The handle an app puts in `_undo.ref`, plus the identity it captured. */
export interface CapturedBefore {
  /** Opaque handle. The platform stores it beside its own token and hands it
   *  back verbatim on reversal; it never interprets it. */
  ref: string;
  entity: string;
  originalId: string;
}

/** One stored before-image, as read back at reversal time. */
export interface JournalRow<T = unknown> {
  entity: string;
  original_id: string;
  /** Which upstream connection the original write targeted, or null for a
   *  single-connection app. See the README on why this is load-bearing. */
  connection: string | null;
  /** The captured object, already JSON.parse'd. */
  before: T;
  /** The raw stored JSON, for callers that would rather parse it themselves. */
  before_json: string;
}

export interface UndoJournalOptions {
  /** The app's D1 binding, usually `env.DB`. */
  db: D1Like;
  /**
   * Table name, e.g. `xero_undo_journal`. Must match the app's own migration
   * (see `undoJournalSchemaSql`). Interpolated into SQL, so it is validated
   * against a strict identifier pattern rather than bound as a parameter.
   */
  table: string;
  /** Log prefix for the package's warnings, e.g. `xero-undo`. */
  scope: string;
  /** Before-image TTL. Defaults to 7 days, matching the platform token TTL. */
  ttlMs?: number;
  /** Refuse to store a before-image larger than this. Defaults to 400,000. */
  maxBeforeJson?: number;
}

export interface CaptureArgs {
  /** Which registry entry knows how to rebuild this. */
  entity: string;
  /** The id being written over or deleted. */
  originalId: string;
  /** The object as read BEFORE the write. */
  before: unknown;
  /**
   * The upstream connection this write targets (store domain, Xero tenantId,
   * simPRO business id, ...), resolved at capture time.
   *
   * Pass null ONLY if the app can hold exactly one connection. See the README:
   * getting this wrong replays into the wrong customer account and nothing
   * errors.
   */
  connection: string | null;
}

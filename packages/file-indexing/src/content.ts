/**
 * Content policy and extraction: what text goes into a row's `content`, and
 * how it gets there. Kept exactly as both apps had it (same caps, same
 * classification, same staging discipline); only the provider calls moved
 * behind the adapter.
 *
 *   - Provider-native documents (Google Docs/Sheets/Slides) export to text.
 *   - TEXT-LIKE files at or under MAX_CONTENT_BYTES are downloaded and decoded.
 *   - BINARY OOXML/PDF files go through the platform extract bridge: download,
 *     stage under a random single-use key, extract, delete the staged copy.
 *     At most MAX_EXTRACTIONS_PER_RUN per pass; pptx and files of 16 MiB or
 *     more come back as a durable job that the drain backfills later.
 *   - Folders, oversize text, legacy .doc/.xls/.ppt and images stay
 *     metadata-only.
 *
 * Every per-file failure leaves that file's content empty and never fails the
 * pass.
 */

import { deleteAppFile, hmacSha256Hex, randomHex, resolveInstallBridge } from '@sprigr/apps-app-sdk';
import type { ExtractFormat, FileIndexingContext, FileSourceAdapter, FileIndexingStore, IndexedFileObject } from './types';
import { deadlinePassed } from './tick-budget';

/** Only TEXT-LIKE files at or under this many bytes are downloaded. */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** The stored `content` never exceeds this many characters. Both apps chose
 *  it so one row stays well inside the search engine's per-object budget
 *  while still giving a long document a useful searchable prefix. */
export const MAX_CONTENT_CHARS = 32000;

/** Files at or above this size can only extract as a durable job (the
 *  platform's inline ceiling), so they are not even downloaded. */
export const MAX_EXTRACT_INLINE_BYTES = 16 * 1024 * 1024;

/** Binary extractions (download + stage + extract) per pass. */
export const MAX_EXTRACTIONS_PER_RUN = 5;

/** Formats the platform always extracts as a durable job. */
export const DURABLE_EXTRACT_FORMATS: ReadonlySet<string> = new Set(['pptx']);

/** Where extraction bytes are staged in app storage. Shared, single-use, random
 *  keys: no provider id ever appears in one (sprigr-apps#2303, #2321). */
export const EXTRACT_STAGING_PREFIX = 'extract-tmp/';

/**
 * Appended to `content` when text was cut to MAX_CONTENT_CHARS, so a reader
 * (and an agent) can tell the row holds a prefix, not the whole document.
 * The cut keeps the marker INSIDE the cap: the stored length never exceeds
 * MAX_CONTENT_CHARS, so this adds no new limit.
 */
export const CONTENT_TRUNCATION_MARKER = '\n[content truncated: the source document is longer than the indexed text]';

const EXTRACT_FORMAT_BY_MIME: Record<string, ExtractFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** MIME types treated as text-like in addition to any `text/*`. */
const TEXT_CONTENT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/tab-separated-values',
  'text/xml',
  'application/json',
  'application/xml',
]);

/** The extract `format` for a binary mime type, or null when the engine cannot
 *  read it (legacy .doc/.xls/.ppt are not OOXML; images, ZIPs, text). */
export function extractFormatForMime(mimeType: string | undefined): ExtractFormat | null {
  if (!mimeType) return null;
  return EXTRACT_FORMAT_BY_MIME[mimeType.toLowerCase()] ?? null;
}

/** True for any `text/*` subtype or one of the explicit application/* text types. */
export function isTextLikeMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const mime = mimeType.toLowerCase();
  return mime.startsWith('text/') || TEXT_CONTENT_MIME_TYPES.has(mime);
}

function markTruncated(text: string, label: string, what: string, originalLength: number): string {
  console.warn(
    `${label} content truncated for ${what}: ${originalLength} chars, stored the first ${
      MAX_CONTENT_CHARS - CONTENT_TRUNCATION_MARKER.length
    } plus a truncation marker (MAX_CONTENT_CHARS ${MAX_CONTENT_CHARS})`,
  );
  return text.slice(0, MAX_CONTENT_CHARS - CONTENT_TRUNCATION_MARKER.length) + CONTENT_TRUNCATION_MARKER;
}

/**
 * Cap text at MAX_CONTENT_CHARS. A cut is never silent: it logs the field and
 * both lengths and ends the stored value with CONTENT_TRUNCATION_MARKER.
 * `alreadyTruncated` marks text a producer (the extract engine, given
 * max_chars) already cut to the cap.
 */
export function capText(
  text: string,
  opts: { label?: string; what?: string; alreadyTruncated?: boolean } = {},
): string {
  const label = opts.label ?? '[file-indexing]';
  const what = opts.what ?? 'a file';
  if (text.length > MAX_CONTENT_CHARS) return markTruncated(text, label, what, text.length);
  if (opts.alreadyTruncated && !text.endsWith(CONTENT_TRUNCATION_MARKER)) {
    return markTruncated(text, label, `${what} (cut by the extract engine)`, text.length);
  }
  return text;
}

/**
 * Durable extraction job token, stable for one version of one file, so a
 * re-walk of an unchanged file converges on the job already running and an
 * edited file gets a fresh one. HMAC-keyed with an install secret because the
 * job record holds extracted text in a shared job area: a colleague who knows
 * the provider ids must not be able to compute it (sprigr-apps#2303, #2321).
 *
 * Reproduces both apps' tokens byte for byte:
 *   google-workspace: namespace 'gws-extract-job', tokenPrefix 'gwx-', ids [fileId]
 *   microsoft-365:    namespace 'ms365-extract-job', tokenPrefix 'msx-', ids [driveId, itemId]
 */
export async function buildExtractJobToken(
  secret: string,
  opts: { namespace: string; tokenPrefix: string; ids: string[]; format: string; version: string | undefined },
): Promise<string> {
  const mac = await hmacSha256Hex(
    secret,
    [opts.namespace, 'v1', ...opts.ids, opts.format, opts.version ?? ''].join('\u0000'),
  );
  return `${opts.tokenPrefix}${mac.slice(0, 40)}`;
}

/** Default staged-copy delete: `files.delete` when the wrapper has it, else
 *  the SDK's install-token delete. Logged, never thrown: the app's sweep of
 *  EXTRACT_STAGING_PREFIX removes any leftover. */
async function defaultDeleteStaged(ctx: FileIndexingContext, key: string, label: string): Promise<void> {
  const files = ctx.env.SPRIGR?.files;
  try {
    if (typeof files?.delete === 'function') {
      await files.delete(key);
      return;
    }
    if (!resolveInstallBridge(ctx.env as Parameters<typeof resolveInstallBridge>[0])) {
      console.warn(`${label} staged extraction ${key} not deleted: no files.delete and no install bridge`);
      return;
    }
    await deleteAppFile(ctx.env as Parameters<typeof deleteAppFile>[0], key);
  } catch (err) {
    console.warn(
      `${label} delete of staged extraction ${key} failed; the sweep retries it:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface BinaryExtractResult {
  text: string;
  deferred?: { jobToken: string };
}

/**
 * Extract text from ONE binary file through the platform bridge: download the
 * bytes (adapter.downloadBinary), stage them under a random key, extract,
 * delete the staged copy whatever happened. A needs_job answer returns the
 * job token so the caller can record a pending row for the drain.
 */
export async function extractBinaryFileContent<TEntry>(
  adapter: FileSourceAdapter<TEntry>,
  ctx: FileIndexingContext,
  object: IndexedFileObject,
  format: ExtractFormat,
  opts: { version?: string } = {},
): Promise<BinaryExtractResult> {
  const label = adapter.logLabel ?? '[file-indexing]';
  const files = ctx.env.SPRIGR?.files;
  if (!files?.extract || !files.putStream || !adapter.downloadBinary) {
    console.warn(
      `${label} extract skipped for ${object.objectID} (${format}): extract/putStream/downloadBinary unavailable; leaving content empty`,
    );
    return { text: '' };
  }
  const tempKey = `${EXTRACT_STAGING_PREFIX}${randomHex(16)}.${format}`;
  let staged = false;
  try {
    const resp = await adapter.downloadBinary(object, ctx);
    if (!resp.ok) {
      console.warn(`${label} binary download failed (${resp.status}) for ${object.objectID}; leaving content empty`);
      return { text: '' };
    }
    // Stream straight into storage when the length is declared, so a large
    // binary never buffers whole in the isolate; buffer only without one.
    const declaredLen = Number(resp.headers.get('content-length') || '') || 0;
    const body = resp.body && declaredLen > 0 ? resp.body : new Uint8Array(await resp.arrayBuffer());
    const length = body instanceof Uint8Array ? body.byteLength : declaredLen;
    // Marked BEFORE the put, so a put that throws after writing is still cleaned up.
    staged = true;
    await files.putStream(tempKey, body, { length });
    const jobToken =
      (DURABLE_EXTRACT_FORMATS.has(format) || length >= MAX_EXTRACT_INLINE_BYTES) && adapter.extractJobToken
        ? await adapter.extractJobToken(object, format, opts.version, ctx).catch((err: unknown) => {
            console.warn(
              `${label} extract job token for ${object.objectID} left to the platform:`,
              err instanceof Error ? err.message : String(err),
            );
            return undefined;
          })
        : undefined;
    const result = await files.extract({
      file_key: tempKey,
      format,
      max_chars: MAX_CONTENT_CHARS,
      ...(jobToken ? { job_token: jobToken } : {}),
    });
    if (result.needs_job) {
      const token = typeof result.job_token === 'string' ? result.job_token : '';
      console.warn(
        `${label} extract deferred (needs_job) for ${object.objectID} (${format}); ${
          token ? 'queued for async backfill' : 'no job_token returned, leaving content empty'
        }`,
      );
      return token ? { text: '', deferred: { jobToken: token } } : { text: '' };
    }
    if (!result.ok || typeof result.text !== 'string') {
      console.warn(
        `${label} extract returned no text for ${object.objectID} (${format})${result.error ? `: ${result.error}` : ''}; leaving content empty`,
      );
      return { text: '' };
    }
    return {
      text: capText(result.text, { label, what: object.objectID, alreadyTruncated: result.truncated === true }),
    };
  } catch (err) {
    console.warn(
      `${label} extract failed for ${object.objectID} (${format}); leaving content empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return { text: '' };
  } finally {
    if (staged) {
      if (adapter.deleteStaged) {
        await adapter.deleteStaged(tempKey, ctx).catch((err: unknown) =>
          console.warn(`${label} staged delete of ${tempKey} failed:`, err instanceof Error ? err.message : String(err)),
        );
      } else {
        await defaultDeleteStaged(ctx, tempKey, label);
      }
    }
  }
}

/** The per-pass extraction counter, shared by every enrich call in one pass
 *  (main walk plus each extra scope) so the cap is truly per pass. */
export interface ExtractionBudget {
  extracted: number;
  deferred: number;
}

export interface EnrichSummary {
  extracted: number;
  deferredBudget: number;
  deferredDeadline: number;
  skippedThrottled: number;
}

/**
 * Populate `content` on already-stamped objects in place. Best-effort per
 * file, bounded by the size and char caps, the shared extraction budget, and
 * the tick deadline (checked between objects; the rest import metadata-only
 * and pick their content up on their next change). A 429 from a download
 * marks that throttle key (default: driveId) so its remaining files are not
 * asked again this pass (sprigr-apps#1527).
 */
export async function enrichObjectsWithContent<TEntry>(
  adapter: FileSourceAdapter<TEntry>,
  store: FileIndexingStore,
  ctx: FileIndexingContext,
  objects: IndexedFileObject[],
  opts: {
    mimeByObjectId?: Map<string, string>;
    budget?: ExtractionBudget;
    throttled?: Set<string>;
  } = {},
): Promise<EnrichSummary> {
  const label = adapter.logLabel ?? '[file-indexing]';
  const budget = opts.budget ?? { extracted: 0, deferred: 0 };
  const throttled = opts.throttled ?? new Set<string>();
  const startExtracted = budget.extracted;
  const startDeferred = budget.deferred;
  let deferredDeadline = 0;
  let skippedThrottled = 0;
  for (const [i, obj] of objects.entries()) {
    if (obj.isFolder === 'true') continue;
    if (deadlinePassed(ctx.deadline, ctx.now)) {
      deferredDeadline = objects.length - i;
      console.warn(
        `${label} content enrichment stopped at the tick deadline: ${deferredDeadline} of ${objects.length} row(s) import metadata-only this run`,
      );
      break;
    }
    const throttleKey = adapter.throttleKeyOf ? adapter.throttleKeyOf(obj) : String(obj.driveId ?? '');
    if (throttled.has(throttleKey)) {
      skippedThrottled++;
      continue;
    }
    const mime = opts.mimeByObjectId?.get(obj.objectID) ?? (typeof obj.mimeType === 'string' ? obj.mimeType : '');
    if (adapter.isNativeExportable?.(mime) && adapter.exportNative) {
      try {
        obj.content = capText(await adapter.exportNative(obj, mime, ctx), { label, what: obj.objectID });
      } catch (err) {
        console.warn(
          `${label} native export failed for ${obj.objectID} (${mime}); leaving content empty:`,
          err instanceof Error ? err.message : String(err),
        );
        obj.content = '';
      }
      continue;
    }
    if (isTextLikeMimeType(mime)) {
      if (typeof obj.size === 'number' && obj.size > MAX_CONTENT_BYTES) continue;
      if (!adapter.downloadText) continue;
      try {
        const got = await adapter.downloadText(obj, ctx);
        const text = typeof got === 'string' ? got : got.text;
        obj.content = capText(text, { label, what: obj.objectID });
        if (typeof got !== 'string' && got.throttled) {
          throttled.add(throttleKey);
          console.warn(`${label} ${throttleKey} is rate-limited (429); skipping content fetches for its remaining items this run`);
        }
      } catch (err) {
        console.warn(
          `${label} content fetch failed for ${obj.objectID}; leaving content empty:`,
          err instanceof Error ? err.message : String(err),
        );
        obj.content = '';
      }
      continue;
    }
    const format = extractFormatForMime(mime);
    if (!format) continue;
    if (typeof obj.size === 'number' && obj.size >= MAX_EXTRACT_INLINE_BYTES) {
      console.warn(
        `${label} extract deferred (needs_job) for ${obj.objectID} (${format}, ${obj.size} bytes >= inline ceiling); leaving content empty this run`,
      );
      continue;
    }
    if (budget.extracted >= MAX_EXTRACTIONS_PER_RUN) {
      budget.deferred++;
      continue;
    }
    budget.extracted++;
    const extract = await extractBinaryFileContent(adapter, ctx, obj, format, {
      version: typeof obj.modifiedAt === 'string' ? obj.modifiedAt : undefined,
    });
    if (extract.deferred) {
      try {
        await store.upsertPendingExtraction({
          objectId: obj.objectID,
          jobToken: extract.deferred.jobToken,
          recordJson: JSON.stringify(obj),
          format,
        });
      } catch (err) {
        console.warn(
          `${label} failed to record pending extraction for ${obj.objectID} (${format}); it stays metadata-only:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      continue;
    }
    obj.content = extract.text;
  }
  const extracted = budget.extracted - startExtracted;
  const deferredBudget = budget.deferred - startDeferred;
  if (extracted > 0 || deferredBudget > 0 || skippedThrottled > 0) {
    console.log(
      `${label} binary extract: attempted ${extracted}, deferred-for-budget ${deferredBudget} (cap ${MAX_EXTRACTIONS_PER_RUN})` +
        (skippedThrottled > 0 ? `; ${skippedThrottled} rows skipped on rate-limited drives` : ''),
    );
  }
  return { extracted, deferredBudget, deferredDeadline, skippedThrottled };
}

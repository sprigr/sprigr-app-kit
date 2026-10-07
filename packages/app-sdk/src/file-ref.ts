/**
 * A file an agent hands an app tool: `{ file_key }` or `{ file_url }`
 * (sprigr/sprigr-app-kit#120).
 *
 * The platform resolves no file argument for an app. An agent passes a plain
 * string and the app turns it into bytes. Three apps had each written that
 * (trello `readInstallFile`, dropbox `resolveSource`, skusavvy `readRef`), and
 * the copies had drifted: only dropbox checked that a company link was signed
 * and in this company, only skusavvy capped time and refused redirects. This
 * module is the one version, with the strictest rules of each.
 *
 * Two steps, usable apart:
 *
 *   resolveFileRef  validation only, no I/O. Run it before an approval card or
 *                   any other side effect, so a malformed call fails first.
 *   readFileRef     resolve, then read the bytes into memory with a size cap,
 *                   a time cap and no redirects. For files an app buffers; an
 *                   app that streams a large file keeps its own reader and
 *                   still calls resolveFileRef.
 *
 * What a reference may be:
 *   - file_key: a key in THIS install's file store, in any form a tool hands
 *     out (app-relative, absolute `_apps/<installId>/...`, or its signed link),
 *     via appKeyFromCallerKey. A key in the company's own storage (an agent's
 *     workspace file) cannot be opened by an app: refused, with how to pass it.
 *   - file_url: an https link on a Sprigr file host only. A link into this
 *     install's storage is read as a key (so it opens the caller's own copy);
 *     a link into the company's storage must be signed and in THIS company.
 *     Nothing else is fetched, so an agent cannot point an app at an arbitrary
 *     host, and every host it can reach is the platform's own.
 */

import { base64ToBytes, fetchFileBytes } from './file';
import { getAppFile, type AppFilesEnv } from './app-files';
import { APP_FILES_ROOT, appKeyFromCallerKey, callerKeyRefusal } from './stored-file-keys';

/** Hosts the platform serves signed file links from (the file proxy, prod and staging). */
export const SPRIGR_FILE_HOSTS: ReadonlySet<string> = new Set(['files.sprigr.com', 'staging-files.sprigr.com']);

/** Default time to read one file before giving up. */
export const DEFAULT_FILE_READ_TIMEOUT_MS = 20_000;

/** Lifetime of the signed link minted to read a stored key. */
const STORED_READ_URL_TTL_SECONDS = 300;

/** How an agent gets a workspace file to an app: a short-lived signed link. */
export const WORKSPACE_FILE_HOW_TO =
  "Apps cannot open a file in your own Sprigr storage by key. Mint a short-lived download link for it (the files tool's generate_url; a few minutes is enough) and pass that link as file_url: the app fetches it itself, so the link never leaves Sprigr.";

export type FileRefErrorCode =
  | 'not_one'
  | 'bad_url'
  | 'not_sprigr_host'
  | 'unsigned_link'
  | 'other_company'
  | 'workspace_key'
  | 'other_install'
  | 'malformed_key'
  | 'internal_key'
  | 'no_file_store'
  | 'not_found'
  | 'too_large'
  | 'timeout'
  | 'read_failed';

/** A refusal or read failure, with a message written for the agent that made the call. */
export class FileRefError extends Error {
  readonly code: FileRefErrorCode;
  constructor(code: FileRefErrorCode, message: string) {
    super(message);
    this.name = 'FileRefError';
    this.code = code;
  }
}

export interface FileRef {
  file_key?: unknown;
  file_url?: unknown;
}

export interface ResolveFileRefOptions {
  /** env.INSTALL_ID: refuses an absolute key or link for another install. */
  installId?: string | null;
  /** env.COMPANY_ID: a company link must be in this company; also spots workspace keys. */
  companyId?: string | null;
  /** App-relative prefixes of the app's own working storage, never a tool's output. */
  internalPrefixes?: readonly string[];
  /** Field name used in messages (default `file`), e.g. `image` or `images[1]`. */
  label?: string;
}

export type ResolvedFileRef =
  | { kind: 'stored'; appKey: string; filename: string }
  | { kind: 'url'; url: string; filename: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function lastSegment(path: string, fallback: string): string {
  const tail = path.split('/').filter(Boolean).pop();
  if (!tail) return fallback;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function isWorkspaceKey(key: string, companyId: string | null | undefined): boolean {
  const k = key.replace(/^\/+/, '');
  if (k.startsWith(APP_FILES_ROOT)) return false;
  if (companyId && k.startsWith(`${companyId}/`)) return true;
  return /^(?:comp_|agt_)[^/]+\//.test(k);
}

function stored(appKey: string, original: string, opts: ResolveFileRefOptions): ResolvedFileRef {
  if ((opts.internalPrefixes ?? []).some((p) => appKey.startsWith(p))) {
    throw new FileRefError('internal_key', `"${original}" is this app's internal working storage, not a file a tool returned. Pass a file_key a tool gave you.`);
  }
  return { kind: 'stored', appKey, filename: lastSegment(appKey, 'file') };
}

/**
 * Check a `{ file_key } | { file_url }` reference and say what to read.
 * Pure: no request is made. Throws FileRefError.
 */
export function resolveFileRef(ref: FileRef | null | undefined, opts: ResolveFileRefOptions = {}): ResolvedFileRef {
  const label = opts.label ?? 'file';
  const key = str(ref?.file_key);
  const url = str(ref?.file_url);
  if ((key === null) === (url === null)) {
    throw new FileRefError('not_one', `${label} takes exactly one of file_key (a key this app's tools returned) or file_url (a Sprigr file link).`);
  }

  if (url !== null) {
    let u: URL;
    let path: string;
    try {
      u = new URL(url);
      path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      throw new FileRefError('bad_url', `${label}.file_url is not a valid URL.`);
    }
    if (u.protocol !== 'https:' || !SPRIGR_FILE_HOSTS.has(u.hostname.toLowerCase())) {
      throw new FileRefError(
        'not_sprigr_host',
        `${label}.file_url must be an https Sprigr file link (on files.sprigr.com), such as the download_url a tool returned. Other web addresses are not fetched.`,
      );
    }
    if (path.startsWith(APP_FILES_ROOT)) {
      // A link into THIS install's storage reads like its key, so it opens the
      // caller's own copy; a link into another install's storage is fetched as
      // the signed link it is.
      const own = appKeyFromCallerKey(url, opts.installId);
      if (own.ok) return stored(own.appKey, url, opts);
      return { kind: 'url', url, filename: lastSegment(path, 'file') };
    }
    if (!opts.companyId || !path.startsWith(`${opts.companyId}/`)) {
      throw new FileRefError('other_company', `${label}.file_url is not a file in this workspace. ${WORKSPACE_FILE_HOW_TO}`);
    }
    if (!u.searchParams.get('token') || !u.searchParams.get('expires')) {
      throw new FileRefError('unsigned_link', `${label}.file_url must be a signed download link (with its token). ${WORKSPACE_FILE_HOW_TO}`);
    }
    return { kind: 'url', url, filename: lastSegment(path, 'file') };
  }

  if (isWorkspaceKey(key!, opts.companyId)) {
    throw new FileRefError('workspace_key', `"${key}" is a file in your own Sprigr storage. ${WORKSPACE_FILE_HOW_TO}`);
  }
  const resolved = appKeyFromCallerKey(key!, opts.installId);
  if (!resolved.ok) {
    if (resolved.reason === 'other_install') {
      throw new FileRefError(
        'other_install',
        `"${key}" is a file of another app. Pass that app's download_url for it as file_url instead; a file_key only opens inside the app that stored it.`,
      );
    }
    throw new FileRefError('malformed_key', callerKeyRefusal(key!, resolved));
  }
  return stored(resolved.appKey, key!, opts);
}

export interface FileRefEnv extends Partial<AppFilesEnv> {
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  /** Present on dispatched handlers: env.SPRIGR.files.url mints a read link. */
  SPRIGR?: unknown;
}

export interface ReadFileRefOptions extends Omit<ResolveFileRefOptions, 'installId' | 'companyId'> {
  /** Byte ceiling for one file (required: pick the downstream API's limit). */
  maxBytes: number;
  /** Default {@link DEFAULT_FILE_READ_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface FileRefContent {
  bytes: Uint8Array;
  size: number;
  contentType: string;
  filename: string;
  /** How the bytes were read: a minted link to a stored key, the install-token fallback, or the caller's link. */
  via: 'bridge' | 'install_token' | 'url';
}

const mb = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;

/**
 * Resolve a reference (with the env's install and company) and read it into
 * memory. Every fetch is time-capped, size-capped, and refuses redirects, so
 * a Sprigr link cannot bounce the read to another host. Throws FileRefError.
 */
export async function readFileRef(env: FileRefEnv, ref: FileRef | null | undefined, opts: ReadFileRefOptions): Promise<FileRefContent> {
  const label = opts.label ?? 'file';
  const resolved = resolveFileRef(ref, { ...opts, installId: env.INSTALL_ID, companyId: env.COMPANY_ID });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FILE_READ_TIMEOUT_MS;
  const tooLarge = (size: number) =>
    new FileRefError('too_large', `${label} is ${mb(size)} MB, over the ${mb(opts.maxBytes)} MB limit, so it was not read.`);

  const fetchCapped = async (url: string) => {
    try {
      return await fetchFileBytes(url, { maxBytes: opts.maxBytes, init: { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' } });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const message = err instanceof Error ? err.message : String(err);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new FileRefError('timeout', `Reading ${label} took longer than ${Math.round(timeoutMs / 1000)}s, so it was not read.`);
      }
      if (/over the \d+-byte cap/.test(message)) throw tooLarge(opts.maxBytes + 1);
      if (/HTTP 404/.test(message)) throw new FileRefError('not_found', `There is no file at ${label} (the link or key may have expired or been deleted).`);
      throw new FileRefError('read_failed', `Could not read ${label}: ${message}`);
    }
  };

  if (resolved.kind === 'url') {
    const got = await fetchCapped(resolved.url);
    return { bytes: got.bytes, size: got.size, contentType: got.contentType, filename: resolved.filename, via: 'url' };
  }

  const files = (env.SPRIGR as { files?: { url?: (key: string, o: { expiresIn: number }) => Promise<{ url?: string } | null> } } | undefined)?.files;
  if (typeof files?.url === 'function') {
    const minted = await files.url(resolved.appKey, { expiresIn: STORED_READ_URL_TTL_SECONDS });
    if (!minted?.url) throw new FileRefError('not_found', `This app's file store has no file at "${resolved.appKey}".`);
    const got = await fetchCapped(minted.url);
    return { bytes: got.bytes, size: got.size, contentType: got.contentType, filename: resolved.filename, via: 'bridge' };
  }
  if (env.SPRIGR_INSTALL_TOKEN && env.SPRIGR_PLATFORM_BASE) {
    const got = await getAppFile(env as AppFilesEnv, resolved.appKey);
    if (got.bytes > opts.maxBytes) throw tooLarge(got.bytes);
    const bytes = base64ToBytes(got.base64 ?? '');
    if (bytes.byteLength > opts.maxBytes) throw tooLarge(bytes.byteLength);
    return {
      bytes,
      size: bytes.byteLength,
      contentType: got.contentType || 'application/octet-stream',
      filename: got.filename || resolved.filename,
      via: 'install_token',
    };
  }
  throw new FileRefError(
    'no_file_store',
    `This runtime has no file store to read ${label}.file_key from (no env.SPRIGR.files and no install token). Pass a Sprigr file link as file_url instead.`,
  );
}

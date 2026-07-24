/**
 * App-scoped R2 file storage (platform feature, 2026-06).
 *
 * Marketplace apps get a contained file store: every key is confined
 * server-side to `_apps/{installId}/...` so an app can only ever touch
 * its own files. The app never holds a raw R2 binding — these helpers
 * call the platform over the same per-install token channel as
 * `env.SPRIGR.emit` (provisioning `/internal/wfp/file/*`).
 *
 * Auth: `Authorization: Bearer <SPRIGR_INSTALL_TOKEN>` against
 * `<SPRIGR_PLATFORM_BASE>/internal/wfp/file/<op>`. Both bindings are
 * stamped onto every per-install WFP upload.
 *
 * Keys are app-relative (`simpro-files/123.jpg`); the platform adds and
 * strips the `_apps/{installId}/` prefix, so the app stays unaware of it
 * and physically cannot escape its namespace.
 */

export interface AppFilesEnv {
  SPRIGR_INSTALL_TOKEN?: string;
  SPRIGR_PLATFORM_BASE?: string;
}

export interface PutAppFileArgs {
  /** App-relative key, e.g. "simpro-files/job-1234/55.jpg". */
  key: string;
  /** File bytes, base64-encoded. */
  base64: string;
  /** MIME type stored as the object's content-type. */
  contentType?: string;
  /** Optional display filename. */
  filename?: string;
}

export interface PutAppFileResult {
  ok: true;
  key: string;
  bytes: number;
  contentType: string;
}

export interface PutAppFileStreamArgs {
  /** App-relative key, e.g. "simpro-files/job-1234/55.jpg". */
  key: string;
  /**
   * Raw file bytes. A `ReadableStream` is piped straight through to R2 so
   * the bytes never fully materialise in the app isolate — use it for large
   * blobs (full-res photos, PDFs). An `ArrayBuffer`/`Uint8Array` is also
   * accepted when the bytes are already in hand.
   */
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array;
  /** MIME type stored as the object's content-type. */
  contentType?: string;
  /** Optional display filename. */
  filename?: string;
  /**
   * Declared byte length. Forward it when known (e.g. the source's
   * Content-Length) so the platform can enforce its size cap before opening
   * the R2 write. Streamed bodies carry no Content-Length, so this is the
   * only length signal the platform gets. Omit for unknown-length streams.
   */
  contentLength?: number;
}

export interface AppFileUrlArgs {
  key: string;
  /** Seconds the signed URL stays valid (default 24h, min 60s, max ~10y, clamped server-side). */
  expiresIn?: number;
}

export interface AppFileUrlResult {
  ok: true;
  url: string;
  expires_at: number;
  key: string;
}

export interface GetAppFileResult {
  ok: true;
  key: string;
  base64: string;
  contentType: string;
  filename?: string;
  bytes: number;
}

export interface AppFileListItem {
  key: string;
  bytes: number;
  uploaded?: string;
  filename?: string;
  contentType?: string;
}

const DEFAULT_PLATFORM_BASE = 'https://webhooks.sprigr.com';

function platformBase(env: AppFilesEnv): string {
  return (env.SPRIGR_PLATFORM_BASE ?? DEFAULT_PLATFORM_BASE).trim().replace(/\/+$/, '');
}

class AppFilesError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AppFilesError';
    this.status = status;
  }
}

function requireToken(env: AppFilesEnv): string {
  const token = env.SPRIGR_INSTALL_TOKEN;
  if (!token) {
    throw new AppFilesError('app file storage unavailable: SPRIGR_INSTALL_TOKEN unset', 500);
  }
  return token;
}

async function parseResult<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).hint ??
           (parsed as Record<string, unknown>).detail ??
           (parsed as Record<string, unknown>).error)
        : text.slice(0, 200);
    throw new AppFilesError(`app file ${op} failed (${res.status}): ${String(detail)}`, res.status);
  }
  return parsed as T;
}

async function call<T>(env: AppFilesEnv, op: string, body: unknown): Promise<T> {
  const token = requireToken(env);
  const res = await fetch(`${platformBase(env)}/internal/wfp/file/${op}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  return parseResult<T>(res, op);
}

/** Store bytes in the app's contained R2 namespace (base64 JSON). */
export function putAppFile(env: AppFilesEnv, args: PutAppFileArgs): Promise<PutAppFileResult> {
  return call<PutAppFileResult>(env, 'put', {
    key: args.key,
    base64: args.base64,
    contentType: args.contentType,
    filename: args.filename,
  });
}

/**
 * Store bytes by streaming the raw body straight into the app's contained
 * R2 namespace. Unlike `putAppFile`, this never base64-encodes the bytes
 * and (with a `ReadableStream` body) never buffers them whole in the
 * isolate — pipe a source `Response.body` directly through for multi-MB
 * blobs. Metadata travels in headers; the body is opaque bytes.
 */
export async function putAppFileStream(
  env: AppFilesEnv,
  args: PutAppFileStreamArgs,
): Promise<PutAppFileResult> {
  const token = requireToken(env);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': args.contentType || 'application/octet-stream',
    'x-app-file-key': args.key,
    'x-app-file-content-type': args.contentType || 'application/octet-stream',
  };
  if (args.filename) headers['x-app-file-name'] = encodeURIComponent(args.filename);
  if (typeof args.contentLength === 'number' && Number.isFinite(args.contentLength)) {
    headers['x-app-file-length'] = String(args.contentLength);
  }
  const res = await fetch(`${platformBase(env)}/internal/wfp/file/put-stream`, {
    method: 'POST',
    headers,
    body: args.body,
    // Required by the Workers runtime when sending a streaming request body.
    ...(args.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit & { duplex?: 'half' });
  return parseResult<PutAppFileResult>(res, 'put-stream');
}

/** Mint a signed, time-limited download URL for an app file. */
export function appFileUrl(env: AppFilesEnv, args: AppFileUrlArgs): Promise<AppFileUrlResult> {
  return call<AppFileUrlResult>(env, 'url', { key: args.key, expiresIn: args.expiresIn });
}

/** Read an app file back as base64. */
export function getAppFile(env: AppFilesEnv, key: string): Promise<GetAppFileResult> {
  return call<GetAppFileResult>(env, 'get', { key });
}

/** List app files under an optional app-relative prefix. */
export function listAppFiles(
  env: AppFilesEnv,
  prefix?: string,
): Promise<{ ok: true; files: AppFileListItem[]; truncated: boolean }> {
  return call(env, 'list', { prefix });
}

/** Delete an app file. */
export function deleteAppFile(env: AppFilesEnv, key: string): Promise<{ ok: true; key: string }> {
  return call(env, 'delete', { key });
}

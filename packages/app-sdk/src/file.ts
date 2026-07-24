/**
 * File helpers for marketplace apps that move binary blobs (attachment
 * upload/download, document fetch). Centralises two foot-guns that bit the
 * platform's own agent runtime before they were caught:
 *
 * 1. Encoding bytes to base64 with `String.fromCharCode(...bytes)` (throws
 *    `RangeError` past ~64 KB) or a byte-at-a-time `binary += ...` loop
 *    (O(n^2) — a 15 MB file pegged the isolate and OOM'd it). `bytesToBase64`
 *    builds the binary string in 32 KB chunks: linear and arity-safe.
 *
 * 2. Fetching a caller-supplied URL with no size limit and holding the whole
 *    body in memory. `fetchFileBytes` enforces a byte ceiling (checks the
 *    Content-Length header up front AND the materialised body) so an oversized
 *    file fails fast with a clear error instead of OOMing the worker.
 *
 * App workers run under Worker-for-Platforms dispatch with the same ~128 MB
 * memory ceiling and a ~25-30 s wall as the agent isolate, so the same
 * discipline applies: never base64 with a byte-at-a-time loop, never pull an
 * unbounded remote file fully into memory. For files larger than a few MB,
 * prefer a Sprigr file-proxy URL reference over inline bytes.
 */

const CHUNK = 0x8000; // 32 KB: under V8's argument-arity cap, keeps encode linear

/** Encode raw bytes as a standard base64 string. */
export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      u8.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Decode a base64 string back to bytes. Tolerates embedded whitespace. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Default ceiling for a single file an app pulls into memory. simPRO/Procore
 * non-segmented uploads are practical only up to a few MB anyway; this leaves
 * headroom while still refusing the multi-tens-of-MB file that would OOM the
 * dispatch worker.
 */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface FetchFileResult {
  bytes: Uint8Array;
  contentType: string;
  size: number;
}

/**
 * Fetch a URL into memory with a hard byte ceiling. Throws (with a message the
 * agent can read) when the file is over `maxBytes`, checking the declared
 * Content-Length first to avoid even downloading an oversized body when the
 * server reports its size.
 *
 * Use this for any "the app fetches a caller-supplied URL" path — e.g. a
 * Sprigr file-proxy signed URL passed in lieu of inline base64.
 */
export async function fetchFileBytes(
  url: string,
  opts: { maxBytes?: number; init?: RequestInit } = {},
): Promise<FetchFileResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const res = await fetch(url, opts.init);
  if (!res.ok) {
    throw new Error(`fetchFileBytes: HTTP ${res.status} fetching file URL`);
  }
  const declared = Number(res.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `fetchFileBytes: file is ${declared} bytes, over the ${maxBytes}-byte cap — ` +
        `use a smaller file or a segmented upload`,
    );
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `fetchFileBytes: file is ${buf.byteLength} bytes, over the ${maxBytes}-byte cap — ` +
        `use a smaller file or a segmented upload`,
    );
  }
  const contentType =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { bytes: new Uint8Array(buf), contentType, size: buf.byteLength };
}

/** Convenience: {@link fetchFileBytes} then base64-encode the result. */
export async function fetchFileAsBase64(
  url: string,
  opts: { maxBytes?: number; init?: RequestInit } = {},
): Promise<{ base64: string; contentType: string; size: number }> {
  const { bytes, contentType, size } = await fetchFileBytes(url, opts);
  return { base64: bytesToBase64(bytes), contentType, size };
}

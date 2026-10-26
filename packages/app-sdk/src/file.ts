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

/** Hosts the platform serves signed file links from (the file proxy, prod and staging). */
export const SPRIGR_FILE_HOSTS: ReadonlySet<string> = new Set(['files.sprigr.com', 'staging-files.sprigr.com']);

/**
 * Which hosts `fetchFileBytes` may fetch. The default is SPRIGR_FILE_HOSTS
 * over https: the URL usually comes from the model, and any other host is a
 * call it chose (sprigr/sprigr-app-kit#185). A list is the only hosts, over
 * https. `'any'` is for an app whose tool takes a public URL by design: http
 * or https to any host except a private, loopback or link-local IP literal,
 * `localhost` or `*.local`. It checks the URL as written: a hostname is not
 * resolved and a redirect is still followed, so it is defence in depth over
 * the Workers runtime, which cannot reach private networks anyway.
 */
export type AllowedFileHosts = Iterable<string> | 'any';

export type FileUrlRefusal = 'bad_url' | 'not_https' | 'host_not_allowed' | 'private_address';

/** The URL was refused before any request was made. The message is written for the agent. */
export class FileUrlRefusedError extends Error {
  readonly code: FileUrlRefusal;
  constructor(code: FileUrlRefusal, message: string) {
    super(message);
    this.name = 'FileUrlRefusedError';
    this.code = code;
  }
}

/** True for a private / loopback / link-local / CGNAT / reserved IPv4 address. */
function isPrivateV4(o: number[]): boolean {
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = o;
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local, incl. the 169.254.169.254 metadata address
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast and reserved
  );
}

/** Expand a URL-normalised IPv6 literal (no brackets) to 8 groups, or null. */
function ipv6Groups(v6: string): number[] | null {
  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(fill, 0)).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/**
 * True for localhost, *.local, and private / loopback / link-local / reserved
 * IP literals. `hostname` is what `new URL()` produced, so it is already
 * normalised (sprigr/sprigr-app-kit#189): IPv4 in decimal, octal, hex or
 * short form arrives dotted, and an IPv4 address embedded in IPv6 arrives as
 * hex groups, so the embedded address is decoded and checked as IPv4.
 * A DNS name is not resolved here (see AllowedFileHosts).
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'local' || h.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateV4(v4.slice(1).map(Number));
  if (!h.includes(':')) return false;
  const g = ipv6Groups(h.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, ''));
  if (!g) return true; // an IPv6 literal we cannot read is refused, not fetched
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (zeros(0, 8)) return true; // :: unspecified
  if (zeros(0, 7) && g7 === 1) return true; // ::1 loopback
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  // IPv4 embedded in IPv6: check the IPv4 address it carries.
  if (zeros(0, 5) && g5 === 0xffff) return isPrivateV4(v4From(g6, g7)); // ::ffff:a.b.c.d mapped
  if (zeros(0, 6)) return isPrivateV4(v4From(g6, g7)); // ::a.b.c.d compatible
  if (zeros(0, 4) && g[4] === 0xffff && g5 === 0) return isPrivateV4(v4From(g6, g7)); // ::ffff:0:a.b.c.d SIIT
  if (g0 === 0x64 && g1 === 0xff9b && zeros(2, 6)) return isPrivateV4(v4From(g6, g7)); // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // NAT64 local-use 64:ff9b:1::/48
  if (g0 === 0x2002) return isPrivateV4(v4From(g1, g2)); // 6to4 2002:a.b.c.d::/48
  return false;
}

/**
 * Check a URL before fetching it, under `allowedHosts` (default
 * SPRIGR_FILE_HOSTS). Returns the parsed URL; throws FileUrlRefusedError.
 * Exported so a tool can refuse at input time, before any side effect.
 */
export function assertFetchableFileUrl(url: string, allowedHosts: AllowedFileHosts = SPRIGR_FILE_HOSTS): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FileUrlRefusedError('bad_url', `"${url.slice(0, 120)}" is not a URL. Pass the full https link of the file, not a key or a path.`);
  }
  const host = u.hostname.toLowerCase();
  if (allowedHosts === 'any') {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new FileUrlRefusedError('not_https', `file URL scheme must be http or https, got ${u.protocol}`);
    }
    if (isPrivateHost(host)) {
      throw new FileUrlRefusedError('private_address', `file URL may not target a private, loopback or link-local address: ${host}`);
    }
    return u;
  }
  if (u.protocol !== 'https:') {
    throw new FileUrlRefusedError('not_https', `file URL must use https, got ${u.protocol}`);
  }
  const allowed = new Set([...allowedHosts].map((h) => h.toLowerCase()));
  if (!allowed.has(host)) {
    throw new FileUrlRefusedError(
      'host_not_allowed',
      `file URL host ${host} is not allowed here; pass a Sprigr file link (https://files.sprigr.com/...), the signed URL a published or stored file gives you.`,
    );
  }
  return u;
}

export interface FetchFileOptions {
  maxBytes?: number;
  init?: RequestInit;
  /** Default SPRIGR_FILE_HOSTS over https. See AllowedFileHosts. */
  allowedHosts?: AllowedFileHosts;
}

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
 * Sprigr file-proxy signed URL passed in lieu of inline base64. The URL is
 * checked against `allowedHosts` first (default SPRIGR_FILE_HOSTS, https);
 * a refused URL throws FileUrlRefusedError and nothing is fetched.
 */
export async function fetchFileBytes(
  url: string,
  opts: FetchFileOptions = {},
): Promise<FetchFileResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  assertFetchableFileUrl(url, opts.allowedHosts);
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
  opts: FetchFileOptions = {},
): Promise<{ base64: string; contentType: string; size: number }> {
  const { bytes, contentType, size } = await fetchFileBytes(url, opts);
  return { base64: bytesToBase64(bytes), contentType, size };
}

/**
 * Is a state-changing request a cross-origin write?
 *
 * The Sprigr session cookie is `Domain=.sprigr.com; SameSite=Lax`, so a page
 * on any tenant site or another app's install is same-site with yours, and a
 * form it auto-submits arrives carrying the signed-in admin's real session
 * (sprigr-app-kit#293). A role gate cannot tell that from the admin's own
 * click. website-serve already drops the viewer identity on such a request
 * (sprigr-team decision 0400); this lets an app refuse it outright as well.
 *
 * Same rule as the platform: GET, HEAD and OPTIONS are never a write.
 * `Sec-Fetch-Site` decides when present (`same-site` or `cross-site` is
 * cross-origin). Without it, an `Origin` that differs from the request's own
 * origin, including `null`, counts. A request with neither header is not a
 * browser acting for someone (a webhook, a server, curl) and is allowed.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CrossOriginWriteSource = 'same-site' | 'cross-site' | 'origin-mismatch';

/** Why this request is a cross-origin write, or null when it is not one. */
export function crossOriginWriteSource(request: Request): CrossOriginWriteSource | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const site = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (site) return site === 'same-site' || site === 'cross-site' ? site : null;
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let own: string;
  try {
    own = new URL(request.url).origin;
  } catch {
    return 'origin-mismatch';
  }
  return origin === own ? null : 'origin-mismatch';
}

/** True when `request` is a write another page made the browser send. */
export function isCrossOriginWrite(request: Request): boolean {
  return crossOriginWriteSource(request) !== null;
}

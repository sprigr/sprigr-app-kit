/**
 * Stored-file keys an agent can open (sprigr/sprigr-apps#2394).
 *
 * The platform hands an app its storage keys INSTALL-RELATIVE
 * (`drive/reads/<id>.docx`): that is the app's own view of its storage, and the
 * platform never names the install prefix or the per-user owner segment in a
 * files response. The platform tool read_file needs the ABSOLUTE key:
 *
 *   `_apps/<installId>/<appKey>`                  (shared storage)
 *   `_apps/<installId>/~u/<ownerHash>/<appKey>`   (a manifest
 *                                                  actor_scoped_storage_prefixes key,
 *                                                  sprigr/sprigr-team#9621)
 *
 * A signed URL from env.SPRIGR.files.url carries exactly that key as its path,
 * so a tool that stores a file and mints a link can hand the agent a key that
 * opens. The github app found the same gap first (sprigr/sprigr-apps#2276,
 * deriveAgentFileKey); this version also accepts the owner segment.
 */

/** Root every marketplace-app file lives under. */
export const APP_FILES_ROOT = '_apps/';

/** The platform's per-user owner segment (sprigr/sprigr-team#9621). An app never
 *  names it in a key it hands env.SPRIGR.files; the platform refuses that. */
export const APP_OWNER_SEGMENT = '~u';

/** One path segment: non-empty, no slash. */
function isSegment(s: string | undefined): s is string {
  return typeof s === 'string' && s.length > 0 && !s.includes('/');
}

/** Strip leading slashes, as the platform does when it resolves a key. */
function trimLeadingSlashes(key: string): string {
  return key.replace(/^\/+/, '');
}

/**
 * Split an absolute app key into its parts, or null when `key` is not
 * `_apps/<installId>/[~u/<ownerHash>/]<rest>` with a non-empty rest.
 */
function parseAbsolute(key: string): { installId: string; ownerHash: string | null; rest: string } | null {
  if (!key.startsWith(APP_FILES_ROOT)) return null;
  const parts = key.slice(APP_FILES_ROOT.length).split('/');
  const installId = parts[0];
  if (!isSegment(installId)) return null;
  let i = 1;
  let ownerHash: string | null = null;
  if (parts[1] === APP_OWNER_SEGMENT) {
    if (!isSegment(parts[2])) return null;
    ownerHash = parts[2];
    i = 3;
  }
  const rest = parts.slice(i).join('/');
  if (!rest || rest.split('/').some((seg) => seg === '')) return null;
  return { installId, ownerHash, rest };
}

/** The decoded path of a URL without its leading slash, or null when it does not parse. */
function urlPathKey(url: string): string | null {
  try {
    return trimLeadingSlashes(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
}

/**
 * The absolute key behind a minted download URL, for the app key it was minted
 * for. Returns null, never a guess, unless the URL path is exactly
 * `_apps/<one segment>/<appKey>` or `_apps/<one segment>/~u/<one segment>/<appKey>`:
 * a key handed to an agent as openable that is not the stored object's key is
 * worse than no key.
 */
export function agentFileKeyFromUrl(downloadUrl: string, appKey: string): string | null {
  const rel = trimLeadingSlashes(appKey);
  if (!rel) return null;
  const path = urlPathKey(downloadUrl);
  if (!path) return null;
  const parsed = parseAbsolute(path);
  if (!parsed || parsed.rest !== rel) return null;
  return path;
}

/**
 * The key a tool returns as `file_key` for a file it stored under `appKey`
 * and minted `downloadUrl` for: the absolute key when it can be read off the
 * URL, otherwise the app key unchanged (the behaviour before sprigr/sprigr-apps#2394).
 */
export function readableStoredKey(appKey: string, downloadUrl: string): string {
  return agentFileKeyFromUrl(downloadUrl, appKey) ?? appKey;
}

/** A caller-supplied stored-file key, resolved to this install's app key. */
export type CallerKeyResolution =
  | {
      ok: true;
      /** The install-relative key to hand env.SPRIGR.files. */
      appKey: string;
      /** True when the caller passed the absolute form or a signed link. */
      wasAbsolute: boolean;
    }
  | {
      ok: false;
      /** `other_install`: an absolute key for a different install. `malformed`:
       *  an `_apps/` key or a link with no file path after the prefix. */
      reason: 'other_install' | 'malformed';
      /** The install the key names, for `other_install`. */
      installId?: string;
    };

/**
 * Accept a stored-file key in any form a tool may have handed out and return
 * the app-relative key for env.SPRIGR.files:
 *   - the app-relative key itself (`drive/reads/<id>.docx`): unchanged;
 *   - the absolute key (`_apps/<installId>/[~u/<hash>/]drive/reads/<id>.docx`);
 *   - the signed download link, whose path is that absolute key.
 *
 * The owner segment is dropped, not checked: the platform re-derives the
 * owner from the call's verified actor (sprigr/sprigr-team#9621), so another user's
 * key resolves to the caller's own copy, which usually does not exist. An
 * absolute key naming a different install is refused when `ownInstallId` is
 * known, because the platform would otherwise read THIS install's file at the
 * same relative path. When it is unknown the key is accepted: the platform
 * still confines every read to this install.
 */
export function appKeyFromCallerKey(key: string, ownInstallId?: string | null): CallerKeyResolution {
  let candidate = key.trim();
  let wasAbsolute = false;
  if (/^https?:\/\//i.test(candidate)) {
    const path = urlPathKey(candidate);
    if (!path || !path.startsWith(APP_FILES_ROOT)) return { ok: false, reason: 'malformed' };
    candidate = path;
  }
  candidate = trimLeadingSlashes(candidate);
  if (candidate.startsWith(APP_FILES_ROOT)) {
    const parsed = parseAbsolute(candidate);
    if (!parsed) return { ok: false, reason: 'malformed' };
    if (ownInstallId && parsed.installId !== ownInstallId) {
      return { ok: false, reason: 'other_install', installId: parsed.installId };
    }
    return { ok: true, appKey: parsed.rest, wasAbsolute: true };
  }
  // A caller that stripped only the install root still carries the owner
  // segment, which the platform refuses as an app key. Drop it the same way.
  const parts = candidate.split('/');
  if (parts[0] === APP_OWNER_SEGMENT) {
    const rest = parts.slice(2).join('/');
    if (!isSegment(parts[1]) || !rest) return { ok: false, reason: 'malformed' };
    return { ok: true, appKey: rest, wasAbsolute: true };
  }
  return { ok: true, appKey: candidate, wasAbsolute };
}

/** The sentence a refusal from appKeyFromCallerKey ends with, naming the key. */
export function callerKeyRefusal(key: string, r: Extract<CallerKeyResolution, { ok: false }>): string {
  if (r.reason === 'other_install') {
    return (
      `"${key}" is a stored file of a different app install (${r.installId}), not this one. ` +
      'Pass a file_key this app returned to you.'
    );
  }
  return `"${key}" is not a stored file key: it has no file path after the app storage prefix.`;
}

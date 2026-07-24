/**
 * Dot-path resolution into a hit object, e.g. 'images.0.url' or
 * 'raw_address.suburb'. Numeric segments index into arrays. Returns undefined
 * for any missing or non-traversable segment (never throws).
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Resolve a dot-path and coerce to a display string ('' when absent). */
export function resolveString(obj: unknown, path: string | undefined): string {
  if (!path) return '';
  const v = resolvePath(obj, path);
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Resolve a dot-path and coerce to a finite number, or null when absent. */
export function resolveNumber(obj: unknown, path: string | undefined): number | null {
  if (!path) return null;
  const v = resolvePath(obj, path);
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

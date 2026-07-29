/**
 * Relative-time helpers. Default to the real wall clock (Date.now()); pass an
 * explicit `now` (epoch ms) to render against a fixed dataset clock, which is
 * what you want for seeded fixtures and deterministic snapshot tests.
 */

/**
 * Parse a timestamp to epoch ms, treating bare SQLite/D1 datetimes as UTC.
 * D1's `datetime('now')` emits "YYYY-MM-DD HH:MM:SS" (UTC, but space-separated
 * with no `T`/`Z`). `new Date("2026-05-30 06:23:04")` parses that as *local*
 * time, skewing every relative time by the browser's UTC offset. Normalising
 * the bare form to `...THH:MM:SSZ` fixes it; ISO strings (with `T`/`Z`/offset)
 * and epoch numbers pass through unchanged.
 */
export function toEpochMs(value: string | number | Date | null | undefined): number {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const s = value.trim();
  const bare = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s);
  return new Date(bare ? `${s.replace(' ', 'T')}Z` : s).getTime();
}

export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const d = now - toEpochMs(iso);
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Render a signed millisecond delta as "in 5m" / "12h overdue". */
export function relFromMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const past = ms <= 0;
  const a = Math.abs(ms);
  const m = Math.round(a / 60000);
  let s: string;
  if (m < 60) s = `${m}m`;
  else if (m < 1440) s = `${Math.round(m / 60)}h`;
  else s = `${Math.round(m / 1440)}d`;
  return past ? `${s} overdue` : `in ${s}`;
}

/** Compact age from a positive millisecond duration: "45m" / "3.2h" / "2.1d". */
export function ageLabel(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round((m / 60) * 10) / 10}h`;
  return `${Math.round((m / 1440) * 10) / 10}d`;
}

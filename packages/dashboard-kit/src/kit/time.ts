/**
 * Relative-time helpers. Default to the real wall clock (Date.now()); pass an
 * explicit `now` (epoch ms) to render against a fixed dataset clock (e.g. demo
 * seed data with an `as_of` timestamp).
 */

export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const d = now - new Date(iso).getTime();
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

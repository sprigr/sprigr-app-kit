/**
 * A plain note for a calendar create whose date may be a year off
 * (sprigr-team#15974): booked for 19 November 2027 two days before
 * 19 November 2026, with the year never said. Apps append it to the result
 * summary the model relays. It states the year; it never blocks or refuses.
 */

const DAY_MS = 86_400_000;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The day number of a real Y-M-D, or null (rejects 2027-02-29, which Date.UTC rolls over). */
function dayNumber(y: number, m: number, d: number): number | null {
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/**
 * The note, or null. Fires when the same day and month a year before the
 * start is today or at most 31 days ahead, which also means the start is at
 * least a year out. The date is the leading YYYY-MM-DD as the caller wrote
 * it, so an offset never moves it to another day.
 */
export function yearAheadNote(startTime: string, nowMs: number = Date.now()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startTime);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (dayNumber(y, mo, d) === null) return null;
  const earlier = dayNumber(y - 1, mo, d);
  if (earlier === null) return null;
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS;
  const gap = earlier - today;
  if (gap < 0 || gap > 31) return null;
  const date = (year: number) => `${d} ${MONTHS[mo - 1]} ${year}`;
  const when = gap === 0 ? 'is today' : gap === 1 ? 'is tomorrow' : `is ${gap} days away`;
  return `This is ${date(y)}, a year from now; ${date(y - 1)} ${when}. Say the year ${y} plainly in your reply.`;
}

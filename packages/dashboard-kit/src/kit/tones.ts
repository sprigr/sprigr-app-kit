/** Shared tone → CSS-var color map used by timelines, tiles, toasts, triage rows. */
export const TONE_C: Record<string, string> = {
  err: 'var(--err)',
  warn: 'var(--warn)',
  ok: 'var(--ok)',
  info: 'var(--info)',
  neutral: 'var(--text-4)',
  accent: 'var(--accent)',
};
export type Tone = keyof typeof TONE_C;

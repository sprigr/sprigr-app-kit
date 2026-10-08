/**
 * Vendor text to Home display text.
 *
 * The platform drops a record whose display strings its sanitizer would
 * change (no markup, no URL, no emoji, no "!"; sprigr-team decision 0174 step
 * 6). Vendor strings routinely carry all four (a meeting called "Standup!",
 * a Meet link as a location, an emoji in a job title), and a dropped record
 * is a meeting or job missing from the viewer's day. So an app cleans the text
 * to the same rules first, and the result is checked with the platform's own
 * rule (homeDisplayTextProblem in fixtures.ts); only what still fails is
 * dropped.
 */
import { homeDisplayTextProblem } from './fixtures';

const URL_RX = /[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*/gi;
const TAG_RX = /<[a-zA-Z/!][^>]*>?/g;
const EMOJI_RX = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** `text` cleaned for Home and cut to `max`, or undefined when nothing displayable is left. */
export function homeDisplayText(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text
    .replace(URL_RX, ' ')
    .replace(TAG_RX, ' ')
    .replace(EMOJI_RX, '')
    .replace(/!/g, '.')
    .replace(/<(?=[a-zA-Z])/g, '< ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  if (!cleaned || homeDisplayTextProblem(cleaned)) return undefined;
  return cleaned;
}

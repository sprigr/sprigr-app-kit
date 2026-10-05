/**
 * Helpers for the text on an approval card for a message send (an email, a
 * chat post), shared so each mail app does not grow its own copy.
 *
 * The card is display only. The grant hash and the arguments the platform
 * replays on approval (sprigr-team decision 0012) carry the full message, so
 * shortening the PREVIEW drops nothing that is sent.
 */

/**
 * Lower-cased addresses from any recipient shape a send tool accepts: an array
 * of `{ email }` objects or strings, or one string separated by commas or
 * semicolons. Feed it to `set()` for an order-insensitive hash part.
 */
export function approvalRecipients(value: unknown): string[] {
  const out: string[] = [];
  const add = (s: unknown) => {
    if (typeof s !== 'string') return;
    for (const part of s.split(/[,;]/)) {
      const t = part.trim().toLowerCase();
      if (t) out.push(t);
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') add((item as { email?: unknown }).email);
      else add(item);
    }
  } else {
    add(value);
  }
  return out;
}

/** Default preview length: enough to recognise the message, short enough not to bury the question. */
export const APPROVAL_PREVIEW_MAX = 600;

/**
 * Plain-text preview of a message body for the card: tags stripped, `&nbsp;`
 * and runs of whitespace collapsed, and an ellipsis when it is cut so the
 * reader can tell the preview is not the whole message.
 */
export function approvalPreview(value: unknown, max: number = APPROVAL_PREVIEW_MAX): string {
  const text = (typeof value === 'string' ? value : '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

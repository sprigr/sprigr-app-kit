/**
 * Email bodies that a mail API always sends as HTML.
 *
 * Outlook (Graph `contentType: 'HTML'`) and Gmail (`text/html`) render the body
 * as HTML, and the agent often writes plain text with line breaks. Rendered as
 * HTML those breaks collapse, so a three-paragraph email arrives as one run-on
 * line. `emailBodyHtml` keeps a body that already carries HTML markup exactly
 * as written, and turns a plain-text body into HTML that shows the same lines:
 * a blank line starts a new paragraph, a single line break becomes `<br>`, and
 * `&`, `<`, `>` and `"` are escaped so the text reads as written.
 *
 * A tool that sends through this declares `emailPreview({ bodyFormat: 'auto' })`.
 * The platform's approval card then applies the same test (`hasHtmlMarkup`) and
 * shows a plain-text body as text, the way it will arrive. Keep the element
 * list in step with `packages/agent-core/src/approval-preview.ts` in sprigr-team.
 */

const HTML_ELEMENT =
  /<\/?(?:a|abbr|b|blockquote|body|br|center|code|del|div|em|font|h[1-6]|head|hr|html|i|img|ins|li|mark|ol|p|pre|s|section|small|span|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|tr|u|ul)(?:\s[^<>]*)?\/?>/i;

/** True when the body contains an HTML element tag or a doctype. */
export function hasHtmlMarkup(body: string): boolean {
  return HTML_ELEMENT.test(body) || /<!doctype\s+html/i.test(body);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The body to hand an HTML-only mail API. HTML input is returned unchanged;
 * plain text becomes paragraphs and line breaks. An empty body stays empty.
 */
export function emailBodyHtml(body: string): string {
  if (body.length === 0 || hasHtmlMarkup(body)) return body;
  const normalized = body.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return body;
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((para) => `<p>${escapeHtml(para.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

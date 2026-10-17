import { describe, expect, it } from 'vitest';
import { emailBodyHtml, hasHtmlMarkup } from '../src/email-body';

describe('emailBodyHtml', () => {
  it('turns a plain-text body into paragraphs and line breaks', () => {
    const text = 'Hi Sam,\n\nThe quote is attached.\nIt is valid for 30 days.\n\nThanks,\nChris';
    expect(emailBodyHtml(text)).toBe(
      '<p>Hi Sam,</p><p>The quote is attached.<br>It is valid for 30 days.</p><p>Thanks,<br>Chris</p>',
    );
  });

  it('handles CRLF and blank lines holding spaces', () => {
    expect(emailBodyHtml('One\r\n  \r\nTwo\r\nThree')).toBe('<p>One</p><p>Two<br>Three</p>');
  });

  it('escapes characters that HTML would read as markup', () => {
    expect(emailBodyHtml('Price < $5 & "net" > cost')).toBe('<p>Price &lt; $5 &amp; &quot;net&quot; &gt; cost</p>');
  });

  it('leaves an HTML body exactly as written', () => {
    const html = '<p>Hi</p>\n<p>Second</p>';
    expect(emailBodyHtml(html)).toBe(html);
    expect(emailBodyHtml('Line one<br>line two')).toBe('Line one<br>line two');
    expect(emailBodyHtml('<!DOCTYPE html><html><body>x</body></html>')).toContain('<!DOCTYPE html>');
  });

  it('keeps an empty or whitespace-only body as it was', () => {
    expect(emailBodyHtml('')).toBe('');
    expect(emailBodyHtml('  \n ')).toBe('  \n ');
  });
});

describe('hasHtmlMarkup', () => {
  it('sees element tags with attributes and self-closing breaks', () => {
    expect(hasHtmlMarkup('<a href="https://x.test">x</a>')).toBe(true);
    expect(hasHtmlMarkup('a<br/>b')).toBe(true);
    expect(hasHtmlMarkup('<DIV class="m">x</DIV>')).toBe(true);
  });

  it('does not mistake comparison signs or angle-bracket addresses for HTML', () => {
    expect(hasHtmlMarkup('if a < b and c > d')).toBe(false);
    expect(hasHtmlMarkup('Chris <chris@example.com>')).toBe(false);
    expect(hasHtmlMarkup('use <placeholder> here')).toBe(false);
  });
});

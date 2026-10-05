import { describe, expect, it } from 'vitest';
import { APPROVAL_PREVIEW_MAX, approvalPreview, approvalRecipients } from '../../src/write-protection/approval-card';
import { approvalPreview as exported } from '../../src/index';

describe('approvalRecipients', () => {
  it('reads every recipient shape a send tool accepts, lower-cased', () => {
    expect(approvalRecipients([{ email: 'A@x.com', name: 'A' }, 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
    expect(approvalRecipients('a@x.com; B@x.com, c@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(approvalRecipients([{ name: 'no email' }, 7, null])).toEqual([]);
    expect(approvalRecipients(undefined)).toEqual([]);
  });
});

describe('approvalPreview', () => {
  it('strips markup and collapses whitespace', () => {
    expect(approvalPreview('<p>hi&nbsp;there</p>\n\n<b>bye</b>')).toBe('hi there bye');
    expect(approvalPreview(undefined)).toBe('');
  });

  it('marks a cut preview with an ellipsis', () => {
    const cut = approvalPreview('x'.repeat(APPROVAL_PREVIEW_MAX + 50));
    expect(cut).toHaveLength(APPROVAL_PREVIEW_MAX + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(approvalPreview('short', 3)).toBe('sho…');
  });

  it('is exported from the package root', () => {
    expect(exported).toBe(approvalPreview);
  });
});

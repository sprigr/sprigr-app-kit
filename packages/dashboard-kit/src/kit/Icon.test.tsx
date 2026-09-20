// Every icon name the app dashboards refer to must resolve to a glyph.
//
// The Icon resolver deliberately falls back to a dot for an unknown name so a
// typo cannot crash a screen, but that made the failure invisible: on
// 2026-09-20 a census across sprigr-apps and sprigr-private-apps found eleven
// names in use with no glyph behind them (a pager's "previous" chevron, the
// Reports tab, every Export button), all shipping as grey circles. This list
// is that census. A screen that adopts a new name adds it here AND to ICONS;
// a rename in ICONS that orphans a name in use fails here, not in production.
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon, ICON_NAMES } from './Icon';

const NAMES_IN_USE = [
  // HubTabs + pagers + toolbars across fulfilment-hub, ascs-*, sinotrans,
  // jsj-provider-connector, boardcave-*.
  'gauge', 'package-check', 'truck', 'boxes', 'alert-triangle', 'clock', 'file-text', 'sliders',
  'chevron-left', 'chevron-right', 'chevron-down', 'chevron-up', 'arrow-left', 'arrow-right',
  'download', 'search', 'copy', 'trash', 'target', 'megaphone', 'layout-dashboard',
  'flask-conical', 'eye', 'external', 'external-link', 'calendar', 'play', 'pause', 'rotate',
  'x-circle', 'check-circle', 'check', 'refresh', 'history', 'info', 'plus', 'minus', 'close',
];

describe('Icon', () => {
  it('has a glyph for every name the dashboards use', () => {
    const missing = NAMES_IN_USE.filter((n) => !ICON_NAMES.includes(n));
    expect(missing).toEqual([]);
  });

  it('renders an svg, not the placeholder dot, for a known name', () => {
    const html = renderToStaticMarkup(<Icon name="chevron-left" />);
    expect(html).toContain('<svg');
  });

  it('renders the placeholder dot and warns once for an unknown name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(<Icon name="no-such-glyph" />);
      expect(html).not.toContain('<svg');
      expect(html).toContain('border-radius:999');
      renderToStaticMarkup(<Icon name="no-such-glyph" />);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('no-such-glyph');
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * DOM smoke test for the embed mount() API.
 *
 * Runs under jsdom. It mounts FacetBrowse via the mount() entry with a mocked
 * fetch (searchKey source) and asserts the UI renders real content: the title,
 * facet counts from the response, and a result card. This exercises the same
 * component tree the built bundle ships, using the real React renderer (the
 * bundle swaps in preact/compat, verified separately by the build smoke check).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from '../embed/mount';
import type { FacetBrowseConfig } from '../src/types';

const RESPONSE = {
  hits: [
    {
      objectID: 'p1',
      title: '6ft Fish',
      brand: 'Album',
      price: 899,
      images: [{ url: 'https://x/a.jpg' }],
      availability: 'in_stock',
      volume_litres: 32,
    },
  ],
  nb_hits: 1,
  page: 0,
  nb_pages: 1,
  facets: { brand: { Album: 1, Firewire: 4 } },
};

const CONFIG: FacetBrowseConfig = {
  title: 'Boardcave',
  source: { kind: 'searchKey', indexName: 'idx', apiKey: 'sk_test' },
  facets: [{ attr: 'brand', label: 'Brand' }],
  card: {
    title: 'title',
    subtitle: 'brand',
    primary: { attr: 'price', format: 'money', locale: 'en-AU' },
    badges: [{ attr: 'availability', map: { in_stock: { label: 'In stock', tone: 'ok' } } }],
    meta: [{ attr: 'volume_litres', suffix: 'L' }],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Poll until the container's textContent includes the marker, or time out.
 *
 * The component debounces the query (160ms) and then awaits an async fetch
 * before committing results, so a fixed sleep races the render under parallel
 * test load (the aggregate "Run all tests" CI job runs every suite at once and
 * a starved worker can blow past any fixed budget). Polling with a generous
 * deadline makes the wait deterministic: fast when idle, tolerant under load.
 * Real timers only: fake timers would freeze both the debounce and the mocked
 * fetch's microtask scheduling, so this file never installs them.
 */
async function waitForText(el: HTMLElement, marker: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((el.textContent ?? '').includes(marker)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForText: "${marker}" did not appear within ${timeoutMs}ms. ` +
          `textContent (first 300 chars): ${(el.textContent ?? '').slice(0, 300)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('embed mount()', () => {
  it('renders the UI, facet counts, and a result card', { timeout: 15000 }, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => RESPONSE,
        text: async () => JSON.stringify(RESPONSE),
      })),
    );

    const host = document.createElement('div');
    document.body.appendChild(host);

    mount(host, CONFIG);
    // Wait for the async source fetch + render commit before asserting.
    await waitForText(host, '6ft Fish');

    const html = host.innerHTML;
    expect(html).toContain('Boardcave'); // title
    expect(host.textContent).toContain('6ft Fish'); // result card title
    expect(host.textContent).toContain('$899'); // formatted money primary
    expect(host.textContent).toContain('In stock'); // badge
    // Facet count from the response's `facets` block.
    expect(host.querySelector('.fb-cnt')?.textContent).toBeTruthy();
    expect(host.querySelector('.fb-card')).not.toBeNull();

    unmount(host);
    expect(host.innerHTML).toBe('');
    host.remove();
  });

  it('mount() throws for a selector that matches nothing', () => {
    expect(() => mount('#does-not-exist', CONFIG)).toThrow(/no element matches/);
  });
});

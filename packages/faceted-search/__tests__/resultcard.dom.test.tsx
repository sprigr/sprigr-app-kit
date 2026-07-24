/**
 * DOM tests for the declarative ResultCard's image-block behavior.
 *
 * - card.image NOT configured: the image block is omitted entirely (no
 *   .fb-thumb, no placeholder glyph, no reserved 4:3 area) and badges render
 *   inline in a .fb-pill-row.
 * - card.image configured but the hit lacks the value: the 4:3 block stays
 *   with the placeholder glyph (uniform grid rhythm).
 *
 * Runs under jsdom (the *.dom.test glob). Uses the same poll-for-content wait
 * as the embed test: React commits asynchronously, and fixed sleeps flake
 * under parallel test load.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ResultCard } from '../src/components/ResultCard';
import type { CardConfig } from '../src/types';

const HIT = {
  objectID: 'lot1',
  address: '12 Example St',
  zoning: 'R2',
  lot_m2: 640,
  qualification: 'qualified',
};

const BADGES: CardConfig['badges'] = [
  { attr: 'qualification', map: { qualified: { label: 'Qualified', tone: 'ok' } } },
];

async function renderCard(card: CardConfig, hit: Record<string, unknown> = HIT): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(createElement(ResultCard, { hit, card }));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (host.querySelector('.fb-card')) return host;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('ResultCard did not render within 10s');
}

describe('ResultCard image block', () => {
  it('omits the image block entirely when card.image is not configured', { timeout: 15000 }, async () => {
    const host = await renderCard({
      title: 'address',
      subtitle: 'zoning',
      badges: BADGES,
      meta: [{ attr: 'lot_m2', suffix: 'm2' }],
    });

    // No image block, no placeholder glyph, no reserved area.
    expect(host.querySelector('.fb-thumb')).toBeNull();
    expect(host.querySelector('.fb-ph')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    // Compact variant class for consumers/styling hooks.
    expect(host.querySelector('.fb-card-noimg')).not.toBeNull();
    // Badges render inline instead of as thumb overlays.
    const row = host.querySelector('.fb-pill-row');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Qualified');
    // Text content still renders.
    expect(host.textContent).toContain('12 Example St');
    expect(host.textContent).toContain('R2');
    host.remove();
  });

  it('keeps the placeholder block when card.image is configured but the hit lacks the value', { timeout: 15000 }, async () => {
    const host = await renderCard({
      image: 'photos.0.url', // configured, but HIT has no photos
      title: 'address',
      badges: BADGES,
    });

    // The 4:3 block and glyph stay; badges overlay the thumb (no inline row).
    expect(host.querySelector('.fb-thumb')).not.toBeNull();
    expect(host.querySelector('.fb-ph')).not.toBeNull();
    expect(host.querySelector('img')).toBeNull(); // no value resolved, no img tag
    expect(host.querySelector('.fb-card-noimg')).toBeNull();
    expect(host.querySelector('.fb-pill-row')).toBeNull();
    expect(host.querySelector('.fb-thumb .fb-pill')?.textContent).toBe('Qualified');
    host.remove();
  });

  it('renders the img tag when card.image is configured and the hit has the value', { timeout: 15000 }, async () => {
    const host = await renderCard(
      { image: 'photos.0.url', title: 'address' },
      { ...HIT, photos: [{ url: 'https://x/lot.jpg' }] },
    );
    const img = host.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://x/lot.jpg');
    host.remove();
  });
});

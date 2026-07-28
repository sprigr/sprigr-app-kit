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

type CardAction = (hit: Record<string, unknown>, value: string) => void | Promise<void>;

async function renderCard(
  card: CardConfig,
  hit: Record<string, unknown> = HIT,
  onCardAction?: CardAction,
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(createElement(ResultCard, { hit, card, onCardAction }));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (host.querySelector('.fb-card')) return host;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('ResultCard did not render within 10s');
}

/** Poll until `check` returns truthy, same rationale as renderCard's wait. */
async function waitFor<T>(check: () => T | null | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
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

    // The 4:3 block and glyph stay; badges overlay the thumb.
    expect(host.querySelector('.fb-thumb')).not.toBeNull();
    expect(host.querySelector('.fb-ph')).not.toBeNull();
    expect(host.querySelector('img')).toBeNull(); // no value resolved, no img tag
    expect(host.querySelector('.fb-card-noimg')).toBeNull();
    // Overlaid badges still live in a .fb-pill-row (see the two-badge test
    // below for why that row is not optional).
    expect(host.querySelector('.fb-thumb > .fb-pill-row')).not.toBeNull();
    expect(host.querySelector('.fb-thumb .fb-pill')?.textContent).toBe('Qualified');
    host.remove();
  });

  it('lays two overlay badges out in a row instead of stacking them', { timeout: 15000 }, async () => {
    const host = await renderCard(
      {
        image: 'photos.0.url',
        title: 'address',
        badges: [
          { attr: 'qualification', map: { qualified: { label: 'Qualified', tone: 'ok' } } },
          { attr: 'review', map: { unreviewed: { label: 'Unreviewed', tone: 'neutral' } } },
        ],
      },
      { ...HIT, review: 'unreviewed' },
    );

    // A bare .fb-pill is position:absolute at top:10px/left:10px, so any pill
    // that is a DIRECT child of .fb-thumb stacks on that one corner and only
    // the tail of whichever sits underneath stays visible. Both pills must go
    // inside the flex row, which resets them to position:static.
    expect(host.querySelectorAll('.fb-thumb > .fb-pill')).toHaveLength(0);

    const row = host.querySelector('.fb-thumb > .fb-pill-row');
    expect(row).not.toBeNull();
    const pills = row!.querySelectorAll('.fb-pill');
    expect(pills).toHaveLength(2);
    expect([...pills].map((p) => p.textContent)).toEqual(['Qualified', 'Unreviewed']);
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

const ACTIONS: CardConfig['actions'] = [
  { value: 'approve', label: 'Approve', tone: 'ok' },
  { value: 'reject', label: 'Reject', tone: 'warn' },
  { value: 'watch', label: 'Watch' },
];

describe('ResultCard actions', () => {
  it('renders no action row and keeps the card as the anchor when actions are not configured', { timeout: 15000 }, async () => {
    const host = await renderCard({ title: 'address', href: 'url' }, { ...HIT, url: 'https://x/lot1' });

    expect(host.querySelector('.fb-actions')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    // The historic markup: .fb-card IS the <a>, not a wrapper around one.
    expect(host.querySelector('a.fb-card')).not.toBeNull();
    expect(host.querySelector('.fb-card-main')).toBeNull();
    expect(host.querySelector('.fb-card-actionable')).toBeNull();
    host.remove();
  });

  it('renders the buttons outside the anchor when actions are configured', { timeout: 15000 }, async () => {
    const host = await renderCard(
      { title: 'address', href: 'url', actions: ACTIONS },
      { ...HIT, url: 'https://x/lot1' },
      () => {},
    );

    const row = host.querySelector('.fb-actions');
    expect(row).not.toBeNull();
    const buttons = row!.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect([...buttons].map((b) => b.textContent)).toEqual(['Approve', 'Reject', 'Watch']);

    // A <button> inside an <a> is invalid HTML and the click navigates instead
    // of firing the handler, so the split markup is the whole point here.
    expect(host.querySelectorAll('a button')).toHaveLength(0);
    // The link half is still present and still carries the href.
    const main = host.querySelector('a.fb-card-main');
    expect(main).not.toBeNull();
    expect(main!.getAttribute('href')).toBe('https://x/lot1');
    expect(host.querySelector('.fb-card.fb-card-actionable')).not.toBeNull();
    host.remove();
  });

  it('calls onCardAction with the hit and the action value', { timeout: 15000 }, async () => {
    const calls: Array<[Record<string, unknown>, string]> = [];
    const hit = { ...HIT, url: 'https://x/lot1' };
    const host = await renderCard({ title: 'address', href: 'url', actions: ACTIONS }, hit, (h, v) => {
      calls.push([h, v]);
    });

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fb-actions button')];
    buttons.find((b) => b.textContent === 'Reject')!.click();

    await waitFor(() => calls.length > 0 || null, 'onCardAction to fire');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(hit);
    expect(calls[0][1]).toBe('reject');
    host.remove();
  });

  it('surfaces a rejected onCardAction inline and re-enables the buttons', { timeout: 15000 }, async () => {
    const host = await renderCard(
      { title: 'address', actions: ACTIONS },
      HIT,
      async () => {
        throw new Error('approval service unreachable');
      },
    );

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fb-actions button')];
    buttons[0].click();

    const err = await waitFor(() => host.querySelector('.fb-act-err'), '.fb-act-err');
    expect(err.textContent).toContain('approval service unreachable');
    expect(err.getAttribute('role')).toBe('status');
    // The failure is recoverable: every button goes back to clickable.
    const after = [...host.querySelectorAll<HTMLButtonElement>('.fb-actions button')];
    expect(after.map((b) => b.disabled)).toEqual([false, false, false]);
    expect(host.querySelector('.fb-act-pending')).toBeNull();
    host.remove();
  });

  it('keeps the error message distinguishable from an err-toned button', { timeout: 15000 }, async () => {
    // Button tones are .fb-act-tone-*, the inline failure message is
    // .fb-act-err. If a tone ever reused the bare .fb-act-err name, this card
    // (which has BOTH an err-toned button and a rendered error) would make
    // `.fb-act-err` ambiguous, and any host styling or test selecting on it
    // would silently pick up the button.
    const host = await renderCard(
      {
        title: 'address',
        actions: [
          { value: 'reject', label: 'Reject', tone: 'err' },
          { value: 'approve', label: 'Approve', tone: 'ok' },
        ],
      },
      HIT,
      async () => {
        throw new Error('boom');
      },
    );

    [...host.querySelectorAll<HTMLButtonElement>('.fb-actions button')][1].click();
    await waitFor(() => host.querySelector('.fb-act-err'), '.fb-act-err');

    const matches = [...host.querySelectorAll('.fb-act-err')];
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe('DIV');
    expect(matches[0].textContent).toContain('boom');
    // The err-toned button is still tone-classed, just under its own namespace.
    expect(host.querySelectorAll('button.fb-act-tone-err')).toHaveLength(1);
    host.remove();
  });

  it('disables the buttons when actions are configured but no onCardAction is supplied', { timeout: 15000 }, async () => {
    const host = await renderCard({ title: 'address', actions: ACTIONS });

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fb-actions button')];
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, true]);
    host.remove();
  });
});

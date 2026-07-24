import { describe, expect, it } from 'vitest';
import { resolveNumber, resolvePath, resolveString } from '../src/utils/path';

const hit = {
  price: 750000,
  price_text: 'Contact agent',
  raw_address: { suburb: 'Bondi', state: 'NSW' },
  images: [{ url: 'https://x/a.jpg' }, { url: 'https://x/b.jpg' }],
  tags: ['a', 'b'],
};

describe('resolvePath', () => {
  it('resolves a nested object path', () => {
    expect(resolvePath(hit, 'raw_address.suburb')).toBe('Bondi');
  });
  it('indexes into arrays with numeric segments', () => {
    expect(resolvePath(hit, 'images.0.url')).toBe('https://x/a.jpg');
    expect(resolvePath(hit, 'images.1.url')).toBe('https://x/b.jpg');
    expect(resolvePath(hit, 'tags.1')).toBe('b');
  });
  it('returns undefined for a missing segment', () => {
    expect(resolvePath(hit, 'raw_address.postcode')).toBeUndefined();
    expect(resolvePath(hit, 'images.9.url')).toBeUndefined();
    expect(resolvePath(hit, 'nope.deeper')).toBeUndefined();
  });
  it('returns undefined for a non-integer array index', () => {
    expect(resolvePath(hit, 'images.x.url')).toBeUndefined();
  });
  it('returns undefined for an empty path', () => {
    expect(resolvePath(hit, '')).toBeUndefined();
  });
  it('never throws on primitives mid-path', () => {
    expect(resolvePath(hit, 'price.nope')).toBeUndefined();
  });
});

describe('resolveString', () => {
  it('coerces numbers to strings', () => {
    expect(resolveString(hit, 'price')).toBe('750000');
  });
  it('returns empty string for missing/undefined path', () => {
    expect(resolveString(hit, 'missing')).toBe('');
    expect(resolveString(hit, undefined)).toBe('');
  });
});

describe('resolveNumber', () => {
  it('returns finite numbers', () => {
    expect(resolveNumber(hit, 'price')).toBe(750000);
  });
  it('coerces numeric strings', () => {
    expect(resolveNumber({ n: '42' }, 'n')).toBe(42);
  });
  it('returns null for non-numeric or missing', () => {
    expect(resolveNumber(hit, 'price_text')).toBeNull();
    expect(resolveNumber(hit, 'missing')).toBeNull();
    expect(resolveNumber(hit, undefined)).toBeNull();
  });
});

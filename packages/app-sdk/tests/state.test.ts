import { describe, expect, it } from 'vitest';
import { encodeState, decodeState } from '../src/state';

describe('OAuth state encode/decode', () => {
  it('round-trips a basic state', () => {
    const original = { installId: 'inst_1', csrf: 'abc', environment: 'sandbox', iat: 1700000000000 };
    const round = decodeState(encodeState(original));
    expect(round).toEqual(original);
  });

  it('handles optional returnTo', () => {
    const original = { installId: 'inst_1', csrf: 'abc', iat: 1700000000000, returnTo: '/dashboard' };
    const round = decodeState(encodeState(original));
    expect(round.returnTo).toBe('/dashboard');
  });

  it('uses URL-safe characters (no +, /, =)', () => {
    const encoded = encodeState({
      installId: 'inst_with_spaces and special / chars +=',
      csrf: 'abc',
      iat: 1,
    });
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

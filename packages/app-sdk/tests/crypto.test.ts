import { describe, expect, it } from 'vitest';
import { constantTimeEqual, hmacSha256Hex, randomHex } from '../src/crypto';

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
  });
  it('returns false for different strings', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});

describe('hmacSha256Hex', () => {
  it('produces a 64-char hex digest', async () => {
    const sig = await hmacSha256Hex('secret', 'message');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic', async () => {
    const a = await hmacSha256Hex('secret', 'message');
    const b = await hmacSha256Hex('secret', 'message');
    expect(a).toBe(b);
  });
});

describe('randomHex', () => {
  it('produces a hex string of expected length', () => {
    const h = randomHex(16);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
  it('produces distinct values across calls', () => {
    const a = randomHex(32);
    const b = randomHex(32);
    expect(a).not.toBe(b);
  });
});

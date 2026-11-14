/**
 * PKCE S256 (RFC 7636) for an app's OAuth connect flow. google-workspace
 * carried these two functions in its own src/lib/pkce.ts (sprigr-apps#4854);
 * google-analytics is the second adopter (sprigr-apps#5021), so they live here
 * instead of in a second copy.
 */
import { describe, expect, it } from 'vitest';
import { codeChallengeS256, newCodeVerifier } from '../src/pkce';
import * as pkg from '../src/index';

// RFC 7636 Appendix B.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('newCodeVerifier', () => {
  it('is 43 to 128 unreserved characters, as RFC 7636 section 4.1 requires', () => {
    const v = newCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('is fresh on every call', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newCodeVerifier()));
    expect(seen.size).toBe(50);
  });
});

describe('codeChallengeS256', () => {
  it('matches the RFC 7636 Appendix B example', async () => {
    expect(await codeChallengeS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it('is base64url with no padding', async () => {
    const c = await codeChallengeS256(newCodeVerifier());
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('package entry point', () => {
  it('exports both functions', () => {
    expect(pkg.newCodeVerifier).toBe(newCodeVerifier);
    expect(pkg.codeChallengeS256).toBe(codeChallengeS256);
  });
});

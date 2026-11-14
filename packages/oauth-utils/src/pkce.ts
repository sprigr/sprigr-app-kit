/**
 * PKCE, S256 (RFC 7636), for an app's OAuth connect flow.
 *
 * Mint a verifier when the connect starts, keep it server-side on the pending
 * row, put `codeChallengeS256(verifier)` on the authorize URL with
 * `code_challenge_method=S256`, and send the verifier as `code_verifier` on
 * the code exchange. Lifted from google-workspace (sprigr-apps#4854) when
 * google-analytics became the second adopter (sprigr-apps#5021).
 */

/** 64 unreserved characters from 32 random bytes; RFC 7636 allows 43 to 128. */
export function newCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** BASE64URL(SHA256(verifier)), no padding: the `code_challenge` for S256. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

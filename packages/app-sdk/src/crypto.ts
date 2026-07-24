/**
 * Crypto helpers for marketplace-app handlers.
 *
 * All operations use SubtleCrypto from the Web Crypto API — available in
 * Cloudflare Workers and Node 20+. No node:crypto imports.
 */

/**
 * Constant-time string compare. Use for bearer-secret / signature
 * verification — never `a === b` with secrets, that leaks length via
 * early exit.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * HMAC-SHA256 → lowercase hex string. Useful for verifying signed
 * payloads from providers that DO sign (Shopify, Slack, etc.). Procore
 * does NOT sign webhook bodies — for Procore we mint our own bearer
 * secret and constant-time-compare.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const msgData = new TextEncoder().encode(message);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, msgData);
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographically random hex string. Used for minting webhook
 * secrets, OAuth state CSRF tokens, etc.
 */
export function randomHex(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

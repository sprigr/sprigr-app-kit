/** sha-256 hex of a csrf. Marker tables key on this, never on the csrf. */
export async function hashCsrf(csrf: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csrf));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Red stub for sprigr-apps#5021: the tests below fail on values.
export function newCodeVerifier(): string {
  return '';
}

export async function codeChallengeS256(_verifier: string): Promise<string> {
  return '';
}

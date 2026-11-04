// Red-first stub: the tests fail on values, not on a missing import.
export type ProviderRevoker = (token: string, opts: { signal: AbortSignal }) => Promise<boolean>;
export interface RevokeTarget { token: string; accountKey?: string }
export interface RevokeOnUninstallOpts {
  targets: readonly RevokeTarget[];
  revoker: ProviderRevoker;
  deadlineAt?: number;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}
export interface RevokeOnUninstallResult { revoked: number; failed: number; notReached: number }
export async function revokeOnUninstall(_opts: RevokeOnUninstallOpts): Promise<RevokeOnUninstallResult> {
  return { revoked: 0, failed: 0, notReached: 0 };
}
export const googleRevoker: ProviderRevoker = async () => false;
export function asanaRevoker(_creds: { clientId: string; clientSecret: string }): ProviderRevoker {
  return async () => false;
}

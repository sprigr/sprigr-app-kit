/**
 * Report an actor whose provider grant is gone for good, so the platform asks
 * a person to reconnect (sprigr/sprigr-team#6149, decision 0388).
 *
 * The platform route takes only the actor key. Who is told, and the words,
 * are the platform's: the person who connected while they are an active
 * member, else the company's admins, with its own reconnect push and email.
 * It sends at most one notice per install and actor per day, so reporting on
 * every failed sync tick is fine.
 */

import { installTokenPost, resolveInstallBridge, type WfpBridgeEnv } from './wfp-bridge';

const REPORT_TIMEOUT_MS = 5_000;

/**
 * True for an `OAuthError` from `@sprigr/apps-oauth-utils` that the provider
 * marked terminal: the grant itself was refused (revoked, expired), not a
 * network error, a 5xx or a refresh race. Matched by name, not instanceof, so
 * a second copy of oauth-utils in the bundle still matches.
 */
export function isConnectionLostError(err: unknown): boolean {
  return err instanceof Error && err.name === 'OAuthError' && (err as { terminal?: unknown }).terminal === true;
}

/**
 * Tell the platform that `actorKey` (`u:<platform user id>` or `a:<agent id>`)
 * lost its connection. Never throws: a failed report must not mask the
 * original error. Resolves true when the platform accepted it.
 */
export async function reportConnectionLost(env: WfpBridgeEnv, actorKey: string): Promise<boolean> {
  const bridge = resolveInstallBridge(env);
  if (!bridge) {
    console.warn('[connection-lost] SPRIGR_PLATFORM_BASE / SPRIGR_INSTALL_TOKEN are not bound; nobody will be asked to reconnect');
    return false;
  }
  try {
    await installTokenPost(bridge, '/internal/wfp/connection-lost', { actor_key: actorKey }, {
      label: 'connection lost',
      timeoutMs: REPORT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    console.warn(`[connection-lost] report for ${actorKey} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

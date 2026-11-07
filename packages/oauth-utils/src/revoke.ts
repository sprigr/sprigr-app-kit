/**
 * Revoke provider grants when an app is uninstalled (sprigr-team#13941).
 *
 * Dropping stored tokens does not end a grant: the provider honours it until
 * it expires. An app's `on_uninstall` hook runs before the platform purges
 * its secrets, so the hook can still read its tokens and send them back.
 * The platform gives that hook 15 s and then tears the install down, so the
 * runner never starts a revoke it cannot finish inside `deadlineAt`.
 *
 * Generalised from google-workspace's hook (sprigr-apps): one revoke per
 * account, a few in flight at once, each cut at `timeoutMs`. Results are
 * counts only; a token never reaches a return value or a log.
 */

/**
 * Sends one token to a provider's revoke endpoint. Answers true only when the
 * provider confirmed it; false for anything else. May throw; the runner
 * treats a throw as false. Must honour `signal`, which aborts at the runner's
 * per-revoke timeout.
 */
export type ProviderRevoker = (token: string, opts: { signal: AbortSignal }) => Promise<boolean>;

export interface RevokeTarget {
  token: string;
  /**
   * The provider account the token belongs to. Rows sharing one send a
   * single revoke; the rest wait for its answer, and send their own token
   * only if it failed.
   */
  accountKey?: string;
}

export interface RevokeOnUninstallOpts {
  targets: readonly RevokeTarget[];
  revoker: ProviderRevoker;
  /**
   * Epoch ms. No revoke starts with less than `timeoutMs` left. For the
   * on_uninstall hook, pass about 12 s after the hook started, which leaves
   * time to delete the local rows inside the platform's 15 s.
   */
  deadlineAt?: number;
  /** Revokes in flight at once. Default 4. */
  concurrency?: number;
  /** Per-revoke cap. Default 5000 ms. */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface RevokeOnUninstallResult {
  /** Targets whose grant the provider confirmed revoked (directly, or through another row on the same account). */
  revoked: number;
  /** Targets whose revoke failed, threw, or timed out. */
  failed: number;
  /** Targets not started because the deadline was too close. */
  notReached: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 5_000;

export async function revokeOnUninstall(opts: RevokeOnUninstallOpts): Promise<RevokeOnUninstallResult> {
  const { targets, revoker } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const tooLate = () => opts.deadlineAt !== undefined && opts.deadlineAt - now() < timeoutMs;
  const byAccount = new Map<string, Promise<boolean>>();
  const result: RevokeOnUninstallResult = { revoked: 0, failed: 0, notReached: 0 };

  await forEachConcurrently(targets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    if (tooLate()) {
      result.notReached++;
      return;
    }
    const key = target.accountKey;
    const shared = key === undefined ? undefined : byAccount.get(key);
    let ok = shared ? await shared : false;
    // No revoke for this account yet, or it failed: send this row's own token
    // while the deadline allows.
    if (!ok && !(shared && tooLate())) {
      const mine = revokeWithin(revoker, target.token, timeoutMs);
      if (key !== undefined) byAccount.set(key, mine);
      ok = await mine;
    }
    if (ok) result.revoked++;
    else result.failed++;
  });
  return result;
}

/** The revoker's answer, false on a throw or once `ms` has passed (and the signal aborts). */
async function revokeWithin(revoker: ProviderRevoker, token: string, ms: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, ms);
  });
  try {
    const answer = revoker(token, { signal: controller.signal }).then(
      (v) => v === true,
      () => false,
    );
    return await Promise.race([answer, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function forEachConcurrently<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/** A revoker that POSTs `token` (plus `params`) as a form to `url`; true on a 2xx. */
export function formPostRevoker(url: string, params: Record<string, string> = {}): ProviderRevoker {
  return async (token, { signal }) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, token }).toString(),
        signal,
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/** Google OAuth 2.0: revoking either the access or the refresh token ends the grant. */
export const googleRevoker: ProviderRevoker = formPostRevoker('https://oauth2.googleapis.com/revoke');

/** Asana OAuth: revoke a refresh token with the app's client credentials. */
export function asanaRevoker(creds: { clientId: string; clientSecret: string }): ProviderRevoker {
  return formPostRevoker('https://app.asana.com/-/oauth_revoke', {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
}

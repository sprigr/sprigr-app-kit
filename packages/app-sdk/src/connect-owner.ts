/**
 * Who a per-actor OAuth connection should belong to.
 *
 * Per-actor apps key their tokens on the caller: `u:<platformUserId>` when a
 * user id is present, otherwise `a:<agentId>`. A settings page is rendered
 * with the viewer's session, so historically the only owner it could offer
 * was the viewer, and every Connect button silently bound the token to
 * whoever clicked it.
 *
 * That is fine right up until it is not. The connection works perfectly in
 * that person's own chats, then a schedule or a workflow runs under a
 * standalone agent's actor, finds no token, and fails `not_connected` hours
 * later and nowhere near the click that caused it. Apps worked around it
 * with a hand-written `?agentId=...` URL, which no customer will ever find.
 *
 * This module gives a settings page the two things it needs to ask the
 * question properly:
 *
 *   listConnectOwners()  the shared agents that can own a connection
 *   buildConnectUrl()    a start URL carrying EXACTLY ONE owner
 *
 * That second one is not a convenience. `actorKey()` prefers the user id
 * whenever both are present, so a link carrying `platformUserId` AND
 * `agentId` silently binds to the user and the agent choice is discarded
 * with no error. Building the URL by hand is precisely how that happens, so
 * the shape is enforced here once rather than trusted to each app.
 */

const CONNECT_OWNERS_PATH = '/internal/wfp/connect-owners';

/** Minimal env shape. Every app's env already carries these two. */
export interface ConnectOwnerEnv {
  SPRIGR_PLATFORM_BASE?: string;
  SPRIGR_INSTALL_TOKEN?: string;
}

/** A shared agent that can own this install's connection. */
export interface ConnectOwner {
  agentId: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * The shared agents in this install's company, for a "connect as" picker.
 *
 * Returns `[]` rather than throwing when the platform cannot be reached or
 * has nothing to offer. A settings page must still render: a workspace with
 * only companion agents is perfectly normal, and losing the whole page
 * because a list of extra options failed to load would be a worse outcome
 * than showing just "connect as me".
 *
 * Companion agents are deliberately absent (the platform filters them):
 * a companion belongs to one person, so "connect as Dave's assistant" is
 * "connect as Dave" with the consequence buried one level deeper.
 */
export async function listConnectOwners(
  env: ConnectOwnerEnv,
  opts: { timeoutMs?: number } = {},
): Promise<ConnectOwner[]> {
  const base = (env.SPRIGR_PLATFORM_BASE ?? '').trim().replace(/\/$/, '');
  const token = env.SPRIGR_INSTALL_TOKEN;
  if (!base || !token) return [];

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(`${base}${CONNECT_OWNERS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { owners?: unknown };
    if (!Array.isArray(body.owners)) return [];
    return body.owners.filter(
      (o): o is ConnectOwner =>
        !!o && typeof (o as ConnectOwner).agentId === 'string' && typeof (o as ConnectOwner).name === 'string',
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an OAuth start URL for exactly one owner.
 *
 * Pass the viewer's id to connect as that person, or an agent id to connect
 * as a shared agent. Passing both is a programming error and throws rather
 * than quietly picking one, because quietly picking one is the bug this
 * module exists to remove.
 */
export function buildConnectUrl(args: {
  /** Usually '/oauth/start'. Relative is fine; it stays relative. */
  startPath: string;
  platformUserId?: string | null;
  agentId?: string | null;
  /** Extra params an app needs to round-trip, e.g. a return path. */
  extra?: Record<string, string>;
}): string {
  const user = args.platformUserId?.trim() || null;
  const agent = args.agentId?.trim() || null;

  if (user && agent) {
    throw new Error(
      'buildConnectUrl: pass platformUserId OR agentId, never both. ' +
        'actorKey() prefers the user id, so a URL carrying both binds the token ' +
        'to the user and silently discards the agent choice.',
    );
  }
  if (!user && !agent) {
    throw new Error('buildConnectUrl: one of platformUserId or agentId is required.');
  }

  const params = new URLSearchParams();
  if (user) params.set('platformUserId', user);
  if (agent) params.set('agentId', agent);
  for (const [k, v] of Object.entries(args.extra ?? {})) params.set(k, v);

  return `${args.startPath}?${params.toString()}`;
}

/**
 * How an existing connection should be described in a list.
 *
 * A row reading "connected" tells nobody whether automations will work.
 * "Shared, usable by automations" versus "Only your own chats" is the
 * distinction that matters, and it is the one the old UI never drew.
 */
export function describeConnectionOwner(actor: {
  platformUserId?: string | null;
  agentId?: string | null;
}): { scope: 'shared' | 'personal'; summary: string } {
  if (actor.agentId && !actor.platformUserId) {
    return {
      scope: 'shared',
      summary: 'Shared. Everyone in the workspace can use it, including scheduled tasks and workflows.',
    };
  }
  return {
    scope: 'personal',
    summary: 'Personal. Only this person\'s own chats can use it; scheduled tasks and workflows cannot.',
  };
}

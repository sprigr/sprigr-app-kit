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
 * This module gives a settings page what it needs to ask the question
 * properly:
 *
 *   listConnectOwners()  the agents a connection can belong to: the
 *                        viewer's own assistant, plus the shared agents
 *   buildConnectUrl()    a start URL carrying EXACTLY ONE owner
 *
 * That second one is not a convenience. `actorKey()` prefers the user id
 * whenever both are present, so a link carrying `platformUserId` AND
 * `agentId` silently binds to the user and the agent choice is discarded
 * with no error. Building the URL by hand is precisely how that happens, so
 * the shape is enforced here once rather than trusted to each app.
 *
 * Prefer `buildConnectUrl({ owner })` over passing raw ids: an owner
 * carries `bindAs`, which already holds the id that works for its kind.
 */

const CONNECT_OWNERS_PATH = '/internal/wfp/connect-owners';

/** Minimal env shape. Every app's env already carries these two. */
export interface ConnectOwnerEnv {
  SPRIGR_PLATFORM_BASE?: string;
  SPRIGR_INSTALL_TOKEN?: string;
}

/**
 * An agent a connection can belong to.
 *
 * `bindAs` carries the ONE id to send to /oauth/start, and it is not always
 * the agent id. A companion agent dispatches as
 * `{agentId, platformUserId: <its owner>}` and `actorKey()` prefers the
 * user, so a companion ALWAYS resolves to `u:<owner>`. A token stored under
 * `a:<companionId>` is unreachable forever: it reads as connected and never
 * once works.
 *
 * So `name` is what the person recognises ("Chris's AI") and `bindAs` is
 * what actually functions. Pass the whole owner to buildConnectUrl and the
 * distinction stays impossible to get wrong.
 */
export interface ConnectOwner {
  kind: 'personal' | 'shared';
  agentId: string;
  name: string;
  slug: string;
  role: string;
  bindAs: { platformUserId: string } | { agentId: string };
}

/**
 * The agents a connection can belong to, for a "connect as" picker.
 *
 * Pass `viewerUserId` and the list leads with that person's OWN assistant
 * (kind 'personal'), followed by the company's shared agents. Omit it and
 * only the shared agents come back.
 *
 * Other people's assistants are never listed. Binding a shared business
 * integration to a colleague's personal agent is the same trap in a new
 * costume, and it is the platform that enforces this, not the caller.
 *
 * Returns `[]` rather than throwing on any failure. A settings page must
 * still render: losing the whole page because an extra list of options
 * failed to load is worse than showing fewer options.
 */
export async function listConnectOwners(
  env: ConnectOwnerEnv,
  opts: { viewerUserId?: string | null; timeoutMs?: number } = {},
): Promise<ConnectOwner[]> {
  const base = (env.SPRIGR_PLATFORM_BASE ?? '').trim().replace(/\/$/, '');
  const token = env.SPRIGR_INSTALL_TOKEN;
  if (!base || !token) return [];

  // Supplying the viewer adds their OWN companion as the "personal" option.
  // Omit it and only shared agents come back.
  const query = new URLSearchParams();
  const viewer = opts.viewerUserId?.trim();
  if (viewer && viewer !== 'anonymous') query.set('viewerUserId', viewer);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 5000);
  try {
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${base}${CONNECT_OWNERS_PATH}${suffix}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { owners?: unknown };
    if (!Array.isArray(body.owners)) return [];
    return body.owners.filter((o): o is ConnectOwner => {
      const c = o as ConnectOwner | null;
      if (!c || typeof c.agentId !== 'string' || typeof c.name !== 'string') return false;
      // An owner with no usable bindAs cannot be connected, so rendering it
      // would offer a button that mints an unreachable token.
      const b = c.bindAs as Record<string, unknown> | undefined;
      return !!b && (typeof b.platformUserId === 'string' || typeof b.agentId === 'string');
    });
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
  /** Preferred: pass the owner straight from listConnectOwners(). */
  owner?: ConnectOwner;
  platformUserId?: string | null;
  agentId?: string | null;
  /** Extra params an app needs to round-trip, e.g. a return path. */
  extra?: Record<string, string>;
}): string {
  const fromOwner = args.owner?.bindAs as Record<string, string> | undefined;
  const user = (fromOwner?.platformUserId ?? args.platformUserId)?.trim() || null;
  const agent = (fromOwner?.agentId ?? args.agentId)?.trim() || null;

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

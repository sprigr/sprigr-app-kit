/**
 * Owner/admin gate for agent tools that change an install-wide connection
 * (connect, disconnect, set the default account). The portal routes have a
 * viewer role check; this is the same rule on the tool path, where there is
 * only `args.actor` (sprigr-team#15236, which replaces the per-app copies from
 * #15148).
 *
 *   A live person drives the turn  -> their own role (`driverRole`) must be
 *                                     owner or admin.
 *   No person drives the turn      -> only surface system, and the agent's
 *                                     bound user must be set and be owner or
 *                                     admin. A website visitor, a channel
 *                                     sender, an MCP client, a webhook, a
 *                                     workflow, another agent and a schedule
 *                                     run also have no person, and are
 *                                     refused, as is a missing surface. A
 *                                     website or channel turn can create a
 *                                     schedule with no recorded creator, so
 *                                     its run proves no admin asked. Widen
 *                                     once the platform stamps a schedule's
 *                                     origin.
 *   Any other person source        -> refused (a schedule's creator, a
 *                                     workflow's saver or starter, a
 *                                     delegation's originator).
 *
 * Compatibility, remove once every gated app runs on a platform that stamps
 * `driverRole` (sprigr-team#15237 on prod): a live person with no `driverRole`
 * passes when they ARE the agent's bound user and the bound role is owner or
 * admin, the #15148 rule. A platform that stamps the field never needs it for
 * a portal chat, and a live person who is not the bound user still needs
 * their own role.
 *
 * Transport-trusted like every `args.actor` field: the wrapper rebuilds it
 * from platform headers on each call, so a caller cannot set it.
 */

import { parseActor } from './actor';

export const CONNECTION_ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Surfaces of a turn no person drove that may act as an owner or admin bound user. */
export const UNATTENDED_ADMIN_SURFACES: ReadonlySet<string> = new Set(['system']);

export interface ConnectionAdminRefusal {
  ok: false;
  error: 'connection_admin_required';
  hint: string;
}

/** null when the caller may change the connection; the refusal to return otherwise. */
export function refuseUnlessConnectionAdminActor(args: unknown, opts: { hint: string }): ConnectionAdminRefusal | null {
  const refusal: ConnectionAdminRefusal = { ok: false, error: 'connection_admin_required', hint: opts.hint };
  const actor = parseActor(args);
  if (!actor) return refusal;
  const boundAdmin = !!actor.platformUserId && !!actor.role && CONNECTION_ADMIN_ROLES.has(actor.role);
  if (!actor.personId) return boundAdmin && !!actor.surface && UNATTENDED_ADMIN_SURFACES.has(actor.surface) ? null : refusal;
  if (actor.personSource !== 'live') return refusal;
  if (actor.driverRole) return CONNECTION_ADMIN_ROLES.has(actor.driverRole) ? null : refusal;
  // Compatibility (see above): no driverRole, so only the bound user on their own role.
  return boundAdmin && actor.personId === actor.platformUserId ? null : refusal;
}

type Handler = (args: unknown, ...rest: unknown[]) => unknown;

/**
 * The named tools of `registry`, each wrapped so the gate runs before anything
 * else, including an approval card the handler would issue. Spread the result
 * over the registry. Throws on a name that is not a function, so a rename
 * cannot silently drop the gate.
 */
export function gateConnectionAdminTools(
  registry: Record<string, unknown>,
  names: readonly string[],
  opts: { hint: string },
): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const name of names) {
    const inner = registry[name];
    if (typeof inner !== 'function') throw new Error(`gateConnectionAdminTools: ${name} is not in the registry`);
    out[name] = async (args, ...rest) => refuseUnlessConnectionAdminActor(args, opts) ?? (inner as Handler)(args, ...rest);
  }
  return out;
}

/**
 * `home.invalidate`: the app's identity-only "my data changed" call
 * (FINAL-APP-FEEDS 5.4; decision 0178).
 *
 * An app calls `env.SPRIGR.home.invalidate({ provider, owner? })` when its own
 * webhook or sync learns that vendor data behind a Home provider changed. The
 * wrapper turns that into `POST /internal/wfp/home/invalidate` with the
 * install token; the platform bumps the provider's generation in the
 * company's HomeCoordinatorDO (debounced there), and the next Home read
 * re-asks the app's Home tool. The call carries NO records: the platform never
 * takes data from it, so it cannot become a push path.
 *
 * Self-contained like the rest of this directory, so `@sprigr/apps-home` can
 * lift it unchanged and an app SDK validates exactly what the route does.
 */

import { HOME_PROVIDER_ID_REGEX } from './vocabulary';

/** The platform route the wrapper's `env.SPRIGR.home.invalidate` calls. */
export const HOME_INVALIDATE_PATH = '/internal/wfp/home/invalidate';

/** The longest body the route reads: a provider id and a user id, with room to spare. */
export const HOME_INVALIDATE_MAX_BODY_CHARS = 1024;

/** The longest platform user id an invalidation may name as its owner. */
export const HOME_INVALIDATE_OWNER_MAX_CHARS = 128;

/** What an app passes to `env.SPRIGR.home.invalidate`. */
export interface HomeInvalidateInput {
  /** One of this app's `home.provides[].id` values. */
  provider: string;
  /**
   * Bump only this person's copy, for a `per_user` provider. The id is the
   * `args.actor.platformUserId` the platform stamped on an earlier dispatch.
   * Absent: every viewer's copy of the provider is stale.
   */
  owner?: { platformUserId: string };
}

/** The body on the wire (snake_case, decision 0013). Nothing else is accepted. */
export interface HomeInvalidateBody {
  provider: string;
  owner_platform_user_id?: string;
}

/** The keys a body may carry; any other key (a `records` array, an install id) is refused. */
export const HOME_INVALIDATE_BODY_KEYS = ['provider', 'owner_platform_user_id'] as const;

/**
 * What the call resolves to. It never rejects for a platform or transport
 * failure, because the provider's TTL is the backstop: `ok: false` names why.
 * A call the platform accepted may still have been coalesced into the
 * debounce window or dropped (an owner who is not an active member who can
 * see the install); the app is not told which.
 */
export type HomeInvalidateResult = { ok: true } | { ok: false; error: string; status?: number; detail?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Problems with a wire body, each a sentence naming the field; empty when it is acceptable. */
export function homeInvalidateBodyProblems(body: unknown): string[] {
  if (!isPlainObject(body)) return ['the body must be an object like { "provider": "my_day" }'];
  const problems: string[] = [];
  for (const key of Object.keys(body)) {
    if (!(HOME_INVALIDATE_BODY_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `"${key}" is not accepted: an invalidation carries only "provider" and "owner_platform_user_id", never records; the platform re-reads your Home tool`,
      );
    }
  }
  if (typeof body.provider !== 'string' || !HOME_PROVIDER_ID_REGEX.test(body.provider)) {
    problems.push('"provider" must be one of this app\'s home.provides[].id values (^[a-z][a-z0-9_]{1,31}$)');
  }
  const owner = body.owner_platform_user_id;
  if (owner !== undefined && (typeof owner !== 'string' || owner === '' || owner.length > HOME_INVALIDATE_OWNER_MAX_CHARS)) {
    problems.push(`"owner_platform_user_id" must be a platform user id of 1 to ${HOME_INVALIDATE_OWNER_MAX_CHARS} characters`);
  }
  return problems;
}

/** The wire body for an SDK input. Throws on an input the route would refuse, naming why. */
export function homeInvalidateBodyFor(input: HomeInvalidateInput): HomeInvalidateBody {
  if (!isPlainObject(input)) throw new Error('home.invalidate takes { provider, owner? }');
  for (const key of Object.keys(input)) {
    if (key !== 'provider' && key !== 'owner') {
      throw new Error(`home.invalidate: "${key}" is not accepted; it takes { provider, owner? } and carries no records`);
    }
  }
  const body: HomeInvalidateBody = { provider: input.provider };
  if (input.owner !== undefined) {
    const owner: unknown = input.owner;
    if (!isPlainObject(owner) || Object.keys(owner).some((k) => k !== 'platformUserId') || typeof owner.platformUserId !== 'string') {
      throw new Error('home.invalidate: owner must be { platformUserId: string }');
    }
    body.owner_platform_user_id = owner.platformUserId;
  }
  const problems = homeInvalidateBodyProblems(body);
  if (problems[0]) throw new Error(`home.invalidate: ${problems[0]}`);
  return body;
}

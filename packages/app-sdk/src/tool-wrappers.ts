/**
 * Adapters between the marketplace wrapper's calling convention and an app's
 * inner handler signatures, with fail-closed per-actor authorization built in.
 *
 * The wrapper calls `handler(args, env, ctx)`, args first. Inner handlers are
 * usually written `(env, args)` or `(env, actor, args)`, so something has to
 * flip them and shape thrown errors into a result an agent can read.
 *
 *   tool(fn)       actor-less handlers: schedules, webhooks, internal work.
 *   actorTool(fn)  per-actor handlers: reads the platform-stamped
 *                  `args.actor`, fails closed with 412 when it is absent, and
 *                  maps NotConnectedError to a 412 `not_connected`.
 *
 * WHY THIS IS IN THE SDK. Every app hand-rolled this wrapper, and the gorgias
 * app got it wrong in the way that matters: when the caller had no connection
 * it fell through to "the first connected actor on the install", so one
 * person's consent made their whole helpdesk readable and writable by every
 * agent on a company-wide install. That reached production. The rule is not
 * hard, but it is easy to write a plausible-looking fallback for, so the
 * correct version belongs in one place that apps import rather than copy.
 *
 * THE RULE: an agent-facing tool resolves the CALLING identity's own
 * credential, or refuses. Never another actor's, not even to be helpful, and
 * not even for a read. Background paths (schedules, webhooks, platform
 * mirrors) genuinely have no caller and need a designated service connection;
 * that is what `tool()` is for, and it is not licence for an agent-facing
 * handler to borrow one.
 */

import { parseActor, type Actor } from './actor';

/** What every wrapped handler returns. `ok:false` never throws past the wrapper. */
export type ToolResult<R> =
  | { ok: true; result: R }
  | { ok: false; error: string; hint?: string; status?: number };

/**
 * Throw this from a token resolver when the CALLING actor has no connection
 * of their own. `actorTool` turns it into a 412 `not_connected` carrying the
 * app's connect hint, which is the agent's cue to mint an authorize link
 * rather than retry.
 *
 * Do not throw it for "the install has no connection at all" on a background
 * path: that is a different failure with a different fix (an admin
 * designating a service connection), and collapsing the two sends the agent
 * chasing a consent link it cannot complete.
 */
export class NotConnectedError extends Error {
  constructor(message = 'The calling actor has no connection with this app.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

/**
 * True for a NotConnectedError, INCLUDING one thrown by a different copy of
 * this module.
 *
 * `instanceof` alone is wrong here and would fail silently. Apps reach this
 * package two ways: a normal npm dependency, and the legacy `sprigrVendor`
 * mirror that copies the source into `src/lib/vendor/`. An app that vendors
 * the SDK while a dependency resolves its own npm copy has TWO distinct
 * `NotConnectedError` classes at runtime, and `instanceof` across them is
 * false. The failure mode is the bad one: the error falls through to the
 * generic branch, the agent gets an opaque message instead of `not_connected`,
 * and never learns to offer a connect link. Matching on `name` as well costs
 * nothing and survives the boundary.
 */
export function isNotConnectedError(err: unknown): boolean {
  if (err instanceof NotConnectedError) return true;
  return err instanceof Error && err.name === 'NotConnectedError';
}

export interface ToolWrapperOptions {
  /**
   * Hint returned alongside `not_connected`. Name the app's connect tool and
   * frame it as a one-click authorization rather than an error, because this
   * string is what the agent repeats to the user.
   */
  notConnectedHint?: string;
  /**
   * Hint returned alongside `no_caller_identity`.
   */
  noCallerIdentityHint?: string;
  /**
   * Shape an app-specific error (a provider API error carrying an HTTP
   * status) into a result. Return null to fall through to the generic
   * `{ error: message }`. Runs AFTER the not_connected check.
   *
   *   mapError: (err) => err instanceof GraphApiError
   *     ? { error: err.message, status: err.status }
   *     : null,
   */
  mapError?: (err: unknown) => { error: string; status?: number; hint?: string } | null;
}

const DEFAULT_NO_CALLER_HINT =
  'The platform did not stamp caller identity on this call. Retry from an agent context.';

const DEFAULT_NOT_CONNECTED_HINT =
  'You have not connected your own account with this app yet, and this tool only ever acts as ' +
  'the person calling it. Use the app\'s connect tool to get an authorize link.';

function shapeError(err: unknown, opts: ToolWrapperOptions): ToolResult<never> {
  const mapped = opts.mapError?.(err);
  if (mapped) return { ok: false, ...mapped };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Wrap an actor-less handler. Catches throws into `{ ok: false, error }` so an
 * agent caller never sees a bare exception.
 */
export function tool<Env, A, R>(
  fn: (env: Env, args: A) => Promise<R>,
  opts: ToolWrapperOptions = {},
): (args: A, env: Env) => Promise<ToolResult<R>> {
  return async (args, env) => {
    try {
      return { ok: true, result: await fn(env, args ?? ({} as A)) };
    } catch (err) {
      return shapeError(err, opts);
    }
  };
}

/**
 * Wrap a per-actor handler. Fails closed twice over: no stamped identity is
 * `no_caller_identity`, and a caller with no connection of their own is
 * `not_connected`. Both 412, both distinct on purpose: the first is a
 * plumbing fault the agent should retry differently, the second the agent can
 * resolve itself by sending the user a link.
 *
 * Identity comes ONLY from the nested, platform-stamped `args.actor`.
 * `parseActor` deliberately ignores flat body fields, which are agent-supplied
 * and spoofable; honouring one would let a caller name any colleague and act
 * as them.
 */
export function actorTool<Env, A, R>(
  fn: (env: Env, actor: Actor, args: A) => Promise<R>,
  opts: ToolWrapperOptions = {},
): (args: A, env: Env) => Promise<ToolResult<R>> {
  return async (args, env) => {
    const actor = parseActor(args);
    if (!actor || (!actor.platformUserId && !actor.agentId)) {
      return {
        ok: false,
        error: 'no_caller_identity',
        hint: opts.noCallerIdentityHint ?? DEFAULT_NO_CALLER_HINT,
        status: 412,
      };
    }
    try {
      return { ok: true, result: await fn(env, actor, args ?? ({} as A)) };
    } catch (err) {
      if (isNotConnectedError(err)) {
        return {
          ok: false,
          error: 'not_connected',
          hint: opts.notConnectedHint ?? DEFAULT_NOT_CONNECTED_HINT,
          status: 412,
        };
      }
      return shapeError(err, opts);
    }
  };
}

/**
 * Bind the options once and get both wrappers typed to the app's env, so
 * handler files call `actorTool(fn)` with no per-call ceremony:
 *
 *   // src/handlers/wrap.ts
 *   export const { tool, actorTool } = createToolWrappers<Ms365Env>({
 *     notConnectedHint: 'Call ms_connect and send the user the link…',
 *     mapError: (err) =>
 *       err instanceof GraphApiError ? { error: err.message, status: err.status } : null,
 *   });
 *
 * Options bound once is the point: an app that repeats them at each of fifty
 * call sites will drift, and the one that drifts is the hint telling a user
 * how to connect.
 */
export function createToolWrappers<Env>(opts: ToolWrapperOptions = {}): {
  tool: <A, R>(
    fn: (env: Env, args: A) => Promise<R>,
  ) => (args: A, env: Env) => Promise<ToolResult<R>>;
  actorTool: <A, R>(
    fn: (env: Env, actor: Actor, args: A) => Promise<R>,
  ) => (args: A, env: Env) => Promise<ToolResult<R>>;
} {
  return {
    tool: (fn) => tool(fn, opts),
    actorTool: (fn) => actorTool(fn, opts),
  };
}

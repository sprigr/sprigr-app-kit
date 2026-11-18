// Both messages are open wording: the owner sets the final text (sprigr-team#15268).

/** The install's sample flag could not be read, so neither the simulator nor the vendor answers. */
export class SampleModeUnknownError extends Error {
  readonly code = 'sample_mode_unknown' as const;

  constructor(options?: { cause?: unknown }) {
    super('Sample mode could not be read for this install, so the request was not sent.', options);
    this.name = 'SampleModeUnknownError';
  }
}

/**
 * Why a request was refused: no route, a query parameter the route does not
 * declare or cannot apply, a response that would not be JSON, a body that is
 * not JSON, a child that names a different parent, an answer missing a field
 * the vendor would have filled in, a create with an id that already exists, a
 * body the route cannot take (any body on an action route, or more than one
 * object on an update), or a body id that is not a usable id.
 */
export type NotSimulatedReason = 'no_route' | 'query' | 'accept' | 'content_type' | 'parent' | 'computed' | 'exists' | 'body' | 'id';

/** Sample mode is on and the engine does not model this request; it is never sent to the vendor. */
export class NotSimulatedError extends Error {
  readonly code = 'not_simulated' as const;
  readonly method: string;
  readonly path: string;
  readonly reason: NotSimulatedReason;

  constructor(method: string, path: string, reason: NotSimulatedReason = 'no_route', options?: { cause?: unknown }) {
    super(`Sample mode is on and ${method} ${path} is not simulated, so the request was not sent.`, options);
    this.name = 'NotSimulatedError';
    this.method = method;
    this.path = path;
    this.reason = reason;
  }
}

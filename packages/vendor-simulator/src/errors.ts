// Both messages are open wording: the owner sets the final text (sprigr-team#15268).

/** The install's sample flag could not be read, so neither the simulator nor the vendor answers. */
export class SampleModeUnknownError extends Error {
  readonly code = 'sample_mode_unknown' as const;

  constructor(options?: { cause?: unknown }) {
    super('Sample mode could not be read for this install, so the request was not sent.', options);
    this.name = 'SampleModeUnknownError';
  }
}

/** Sample mode is on and the dialect has no route for this request; it is never sent to the vendor. */
export class NotSimulatedError extends Error {
  readonly code = 'not_simulated' as const;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string) {
    super(`Sample mode is on and ${method} ${path} is not simulated, so the request was not sent.`);
    this.name = 'NotSimulatedError';
    this.method = method;
    this.path = path;
  }
}

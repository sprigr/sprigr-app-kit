import { SampleModeUnknownError } from './errors';
import type { FetchImpl, SampleMode, SampleStore, SampleSwitch } from './types';

/**
 * Reads the flag at most once, on first use, and keeps the answer, a failed
 * read included. Build one per invocation: a switch kept across requests would
 * miss a flip.
 */
export function createSampleSwitch(store: SampleStore): SampleSwitch {
  let memo: Promise<SampleMode> | undefined;
  let readError: unknown;
  return {
    mode(): Promise<SampleMode> {
      memo ??= store.isOn().then<SampleMode, SampleMode>(
        (on) => (on ? 'on' : 'off'),
        (err: unknown) => {
          readError = err;
          return 'unknown';
        },
      );
      return memo;
    },
    readError: () => readError,
  };
}

export interface SampleAwareFetchOptions {
  sampleSwitch: SampleSwitch;
  simulator: { fetch: FetchImpl };
  /** The real fetch, used only when the flag reads off. */
  network: FetchImpl;
}

/** A FetchImpl for fetchWithBudget's `fetchImpl` option, or any vendor client. */
export function sampleAwareFetch({ sampleSwitch, simulator, network }: SampleAwareFetchOptions): FetchImpl {
  return async (input, init) => {
    const mode = await sampleSwitch.mode();
    if (mode === 'on') return simulator.fetch(input, init);
    if (mode === 'off') return network(input, init);
    throw new SampleModeUnknownError({ cause: sampleSwitch.readError?.() });
  };
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** on: answer from the simulator. off: the real vendor. unknown: refuse both. */
export type SampleMode = 'on' | 'off' | 'unknown';

/** The flag row lives in the overlay table under a resource no app uses. */
export const SAMPLE_FLAG_RESOURCE = '__sample_mode__';
export const SAMPLE_FLAG_ID = 'flag';

export type SampleObject = Record<string, unknown>;

export interface OverlayRow {
  id: string;
  /** The whole object as JSON; `{}` for a deleted row. */
  body: string;
  deleted: boolean;
}

export interface SampleStore {
  /** Throws when the read fails; the switch turns that into `unknown`. */
  isOn(): Promise<boolean>;
  setOn(): Promise<void>;
  listOverlay(resource: string): Promise<OverlayRow[]>;
  /** `null` records a delete. */
  put(resource: string, id: string, body: SampleObject | null): Promise<void>;
  /** Deletes the flag and every overlay row in one statement. */
  clear(): Promise<void>;
}

export interface SampleSwitch {
  mode(): Promise<SampleMode>;
  /** Why the flag read failed, when `mode()` answered `unknown`. */
  readError?(): unknown;
}

export interface SeedResource {
  idField: string;
  items: SampleObject[];
}

export type SampleSeed = Record<string, SeedResource>;

/**
 * Types for the durable-jobs surface (env.SPRIGR.jobs), plus jobIsLive
 * (sprigr-app-kit#176). Apps used to copy these, and the copies drifted:
 * one declared `get` as the `{ ok, job }` envelope while the wrapper returns
 * the bare record, so every live job read as dead.
 */

/**
 * What a step tells the platform to do next. `complete` and `fail` are
 * terminal; `fail` with `retryable: false` skips the job's retry budget.
 */
export type JobDirective =
  | { op: 'continue'; state?: unknown; label?: string }
  | { op: 'sleep'; seconds: number; state?: unknown; label?: string }
  | { op: 'wait'; reason?: string; timeout_seconds?: number; state?: unknown; label?: string }
  | { op: 'complete'; result?: unknown }
  | { op: 'fail'; error?: string; retryable?: boolean };

/**
 * The single argument a step function receives. `P` is the job's params,
 * `S` the state the previous step returned; `state` is null on step 0.
 */
export interface JobStepArgs<P = unknown, S = unknown> {
  job: {
    id: string;
    name: string;
    step: number;
    attempt: number;
    params: P;
    state: S | null;
    signal?: { delivered: boolean; payload?: unknown };
  };
}

export type SprigrJobStatus = 'queued' | 'running' | 'sleeping' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface SprigrJobRecord {
  job_id: string;
  name: string;
  status: SprigrJobStatus;
  label?: string | null;
  waiting_reason?: string | null;
  step_count?: number;
  params?: unknown;
  state?: unknown;
  result?: unknown;
  error?: string | null;
  [key: string]: unknown;
}

export interface SprigrJobsApi {
  start(args: { name: string; params?: unknown; idempotencyKey?: string }): Promise<{ ok: boolean; existing: boolean; job: SprigrJobRecord }>;
  /** Resolves to the job record itself, not the `{ ok, existing, job }` envelope `start` returns. */
  get(jobId: string): Promise<SprigrJobRecord>;
  signal(jobId: string, payload?: unknown): Promise<{ ok: boolean; delivered: boolean }>;
  cancel(jobId: string): Promise<{ ok: boolean; status: string }>;
  /** The wrapper resolves to the bare array; read it with {@link listedJobs}, never `.jobs`. */
  list(args?: { name?: string; status?: string; limit?: number }): Promise<SprigrJobsListResult>;
}

/** What `jobs.list` resolves to: the bare array today, or a `{ jobs }` envelope from another host. */
export type SprigrJobsListResult = SprigrJobRecord[] | { ok?: boolean; jobs?: SprigrJobRecord[] };

/**
 * The records in a `jobs.list` answer, whichever shape it came in. Reading
 * `.jobs` off the bare array gives undefined, which a "is a run already live?"
 * guard reads as none and starts a duplicate.
 */
export function listedJobs(res: SprigrJobsListResult | null | undefined): SprigrJobRecord[] {
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.jobs) ? res.jobs : [];
}

/** The statuses in which a job can still take another step. */
export const LIVE_JOB_STATUSES: ReadonlySet<SprigrJobStatus> = new Set(['queued', 'running', 'sleeping', 'waiting']);

/**
 * Whether `jobId` can still run. Accepts `get` returning the bare record or a
 * `{ job }` envelope. A lookup that throws counts as live: wrongly leaving a
 * job alone costs one tick, wrongly starting a second one runs two jobs on
 * one piece of work. With no jobs surface, nothing is live.
 */
export async function jobIsLive(
  jobs: Pick<SprigrJobsApi, 'get'> | undefined,
  jobId: string,
  onLookupError?: (err: unknown) => void,
): Promise<boolean> {
  if (!jobs) return false;
  try {
    const res = (await jobs.get(jobId)) as unknown;
    const record = res && typeof res === 'object' && 'job' in res ? (res as { job?: unknown }).job : res;
    const status = record && typeof record === 'object' ? (record as { status?: unknown }).status : undefined;
    return typeof status === 'string' && LIVE_JOB_STATUSES.has(status as SprigrJobStatus);
  } catch (err) {
    onLookupError?.(err);
    return true;
  }
}

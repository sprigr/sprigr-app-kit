import { describe, expect, it, vi } from 'vitest';
import { jobIsLive, listedJobs, type SprigrJobRecord, type SprigrJobsApi } from '../src/jobs';

const rec = (status: SprigrJobRecord['status']): SprigrJobRecord => ({ job_id: 'job_1', name: 'walk', status });

describe('jobIsLive (#176)', () => {
  it.each(['queued', 'running', 'sleeping', 'waiting'] as const)('reads a bare %s record as live (what the wrapper returns)', async (s) => {
    expect(await jobIsLive({ get: async () => rec(s) }, 'job_1')).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('reads a %s job as not live', async (s) => {
    expect(await jobIsLive({ get: async () => rec(s) }, 'job_1')).toBe(false);
  });

  it('also accepts the { ok, job } envelope, the shape that once made every live job read dead', async () => {
    const get = async () => ({ ok: true, job: rec('running') }) as unknown as SprigrJobRecord;
    expect(await jobIsLive({ get }, 'job_1')).toBe(true);
  });

  it('treats a failed lookup as live, and reports it', async () => {
    const onErr = vi.fn();
    const boom = new Error('jobs_get_failed');
    expect(await jobIsLive({ get: async () => { throw boom; } }, 'job_1', onErr)).toBe(true);
    expect(onErr).toHaveBeenCalledWith(boom);
  });

  it('reads no jobs surface, or a record with no status, as not live', async () => {
    expect(await jobIsLive(undefined, 'job_1')).toBe(false);
    expect(await jobIsLive({ get: async () => ({}) as SprigrJobRecord }, 'job_1')).toBe(false);
  });
});

describe('listedJobs (#176)', () => {
  it('reads the bare array the wrapper returns from jobs.list', async () => {
    const jobs: Pick<SprigrJobsApi, 'list'> = { list: async () => [rec('running'), rec('completed')] };
    expect(listedJobs(await jobs.list({ name: 'walk' })).map((j) => j.status)).toEqual(['running', 'completed']);
  });

  it('reads a { jobs } envelope too', () => {
    expect(listedJobs({ ok: true, jobs: [rec('queued')] })).toEqual([rec('queued')]);
  });

  it('reads nothing usable as no jobs', () => {
    expect(listedJobs(undefined)).toEqual([]);
    expect(listedJobs(null)).toEqual([]);
    expect(listedJobs({ ok: true })).toEqual([]);
  });
});

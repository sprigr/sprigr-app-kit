import { describe, expect, it, vi } from 'vitest';
import { jobIsLive, type SprigrJobRecord } from '../src/jobs';

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

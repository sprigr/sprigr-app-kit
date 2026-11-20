/**
 * env.SPRIGR.log refuses an entry without a category of [A-Za-z0-9._:-] and a
 * summary, so report() must always send both or the telemetry is lost.
 */
import { describe, expect, it, vi } from 'vitest';
import { report, type MockWarehouseEnv } from '../src/lib/env';

const CATEGORY = /^[A-Za-z0-9._:-]{1,64}$/;

function envWithLog() {
  const log = vi.fn(async () => undefined);
  const env: MockWarehouseEnv = { SPRIGR: { emit: vi.fn(async () => undefined), log } };
  return { env, log };
}

describe('report', () => {
  it.each(['advance', 'needs a space'])('sends a valid category and the message as summary for %s', async (message) => {
    const { env, log } = envWithLog();
    await report(env, message, { orderId: 'o1' });
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as { level: string; category: string; summary: string; metadata: unknown };
    expect(entry.level).toBe('info');
    expect(entry.category).toMatch(CATEGORY);
    expect(entry.summary).toBe(message);
    expect(entry.metadata).toEqual({ orderId: 'o1' });
  });
});

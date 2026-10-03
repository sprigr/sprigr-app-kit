import { describe, it, expect, vi } from 'vitest';
import { ActorRefreshLatch, needsRefresh, REFRESH_BUFFER_MS } from '../src/index';

describe('needsRefresh', () => {
  it('is true when there is no access token', () => {
    expect(needsRefresh({ access_token: null, expires_at: Date.now() + 3600_000 })).toBe(true);
  });

  it('is true when expiry is unknown', () => {
    expect(needsRefresh({ access_token: 'at', expires_at: null })).toBe(true);
  });

  it('is true within the refresh buffer of expiry', () => {
    expect(
      needsRefresh({ access_token: 'at', expires_at: Date.now() + REFRESH_BUFFER_MS - 1 }),
    ).toBe(true);
  });

  it('is true once already expired', () => {
    expect(needsRefresh({ access_token: 'at', expires_at: Date.now() - 1 })).toBe(true);
  });

  it('is false when comfortably fresh', () => {
    expect(
      needsRefresh({ access_token: 'at', expires_at: Date.now() + REFRESH_BUFFER_MS + 60_000 }),
    ).toBe(false);
  });

  it('is true when forced even if fresh', () => {
    expect(
      needsRefresh(
        { access_token: 'at', expires_at: Date.now() + REFRESH_BUFFER_MS + 60_000 },
        { force: true },
      ),
    ).toBe(true);
  });
});

describe('ActorRefreshLatch', () => {
  it('coalesces concurrent calls for the same key onto one refresh', async () => {
    const latch = new ActorRefreshLatch<string>();
    let calls = 0;
    let resolveRefresh!: (v: string) => void;
    const refresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          calls++;
          resolveRefresh = resolve;
        }),
    );

    const first = latch.run('actor-1', refresh);
    const second = latch.run('actor-1', refresh);

    expect(calls).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh('fresh-token');
    await expect(first).resolves.toBe('fresh-token');
    await expect(second).resolves.toBe('fresh-token');
  });

  it('runs independent refreshes for different keys', async () => {
    const latch = new ActorRefreshLatch<string>();
    const refreshA = vi.fn(async () => 'a');
    const refreshB = vi.fn(async () => 'b');

    const [a, b] = await Promise.all([latch.run('actor-a', refreshA), latch.run('actor-b', refreshB)]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight entry after resolving, so a later call refreshes again', async () => {
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'v');

    await latch.run('actor-1', refresh);
    await latch.run('actor-1', refresh);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry after rejecting, so a later call retries', async () => {
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');

    await expect(latch.run('actor-1', refresh)).rejects.toThrow('boom');
    await expect(latch.run('actor-1', refresh)).resolves.toBe('recovered');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a caller that joins an in-flight refresh also sees a rejection', async () => {
    const latch = new ActorRefreshLatch<string>();
    let rejectRefresh!: (e: Error) => void;
    const refresh = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );

    const first = latch.run('actor-1', refresh);
    const second = latch.run('actor-1', refresh);

    rejectRefresh(new Error('provider down'));
    await expect(first).rejects.toThrow('provider down');
    await expect(second).rejects.toThrow('provider down');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

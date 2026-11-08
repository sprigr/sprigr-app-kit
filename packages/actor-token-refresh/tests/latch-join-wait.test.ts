import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ActorRefreshLatch,
  REFRESH_JOIN_WAIT_MS,
  RefreshLeaseBusyError,
  type D1Like,
  type RefreshLeaseConfig,
} from '../src/index';

// sprigr/sprigr-app-kit#272: a joiner shares the owner's promise. In Workers
// a promise owned by a torn-down request never settles, so the joiner hung.
const never = <T>() => new Promise<T>(() => {});

/** A lease table whose row another caller already holds: every acquire loses. */
function leaseHeldElsewhere(): RefreshLeaseConfig<string> {
  const stmt = {
    bind: () => stmt,
    run: async () => ({ meta: { changes: 0 } }),
    first: async () => null,
  };
  const db: D1Like = { prepare: () => stmt };
  return { db, table: 'refresh_lease', cachedToken: async () => null, waitMs: 500 };
}

function track<T>(p: Promise<T>) {
  const s: { value?: T; error?: unknown; done: boolean } = { done: false };
  p.then(
    (value) => Object.assign(s, { value, done: true }),
    (error) => Object.assign(s, { error, done: true }),
  );
  return s;
}

describe('ActorRefreshLatch join wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a joiner whose shared refresh never settles refreshes on its own at the join wait', async () => {
    const latch = new ActorRefreshLatch<string>();
    const owner = vi.fn(() => never<string>());
    void latch.run('actor-1', owner);

    const own = vi.fn(async () => 'own-token');
    const joiner = track(latch.run('actor-1', own));

    await vi.advanceTimersByTimeAsync(REFRESH_JOIN_WAIT_MS - 1);
    expect(joiner.done).toBe(false);
    expect(own).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(joiner).toMatchObject({ done: true, value: 'own-token' });
    expect(owner).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('with a lease the owner still holds, the joiner gets a bounded RefreshLeaseBusyError', async () => {
    const latch = new ActorRefreshLatch<string>();
    void latch.run('actor-1', () => never<string>());

    const own = vi.fn(async () => 'own-token');
    const joiner = track(latch.run('actor-1', own, leaseHeldElsewhere()));

    await vi.advanceTimersByTimeAsync(REFRESH_JOIN_WAIT_MS + 500);
    expect(joiner.done).toBe(true);
    expect(joiner.error).toBeInstanceOf(RefreshLeaseBusyError);
    expect(own).not.toHaveBeenCalled();
  });

  it('an owner that settles within the join wait is still shared, with one refresh', async () => {
    const latch = new ActorRefreshLatch<string>();
    let resolveOwner!: (v: string) => void;
    const owner = vi.fn(() => new Promise<string>((r) => (resolveOwner = r)));
    const first = track(latch.run('actor-1', owner));
    const own = vi.fn(async () => 'own-token');
    const second = track(latch.run('actor-1', own));

    await vi.advanceTimersByTimeAsync(REFRESH_JOIN_WAIT_MS - 1);
    resolveOwner('owner-token');
    await vi.advanceTimersByTimeAsync(0);

    expect(first).toMatchObject({ done: true, value: 'owner-token' });
    expect(second).toMatchObject({ done: true, value: 'owner-token' });
    expect(own).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stale owner that settles late does not evict the refresh that replaced it', async () => {
    const latch = new ActorRefreshLatch<string>();
    let resolveStale!: (v: string) => void;
    void latch.run('actor-1', () => new Promise<string>((r) => (resolveStale = r)));

    let resolveReplacement!: (v: string) => void;
    const replacement = vi.fn(() => new Promise<string>((r) => (resolveReplacement = r)));
    const joiner = track(latch.run('actor-1', replacement));
    await vi.advanceTimersByTimeAsync(REFRESH_JOIN_WAIT_MS);
    expect(replacement).toHaveBeenCalledTimes(1);

    resolveStale('stale-token');
    await vi.advanceTimersByTimeAsync(0);

    const third = vi.fn(async () => 'third-token');
    const late = track(latch.run('actor-1', third));
    resolveReplacement('replacement-token');
    await vi.advanceTimersByTimeAsync(0);

    expect(joiner).toMatchObject({ done: true, value: 'replacement-token' });
    expect(late).toMatchObject({ done: true, value: 'replacement-token' });
    expect(third).not.toHaveBeenCalled();
  });
});

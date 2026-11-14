/**
 * The late-row timer (sprigr-app-kit#267): a tick that is about to be cut at
 * the dispatch wall writes one row while it still can. It must fire once, at
 * its mark, never after the run stopped, and a failing writer must not take
 * the tick down with it. Fake clock and fake timers.
 */
import { describe, expect, it, vi } from 'vitest';
import { newCallTiming } from '../src/tick-timing';
import { lateTimingFields, watchLate, type LateTimers } from '../src/tick-late';

function fakeTimers(start = 1_000) {
  const c = { t: start };
  const pending = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const timers: LateTimers = {
    set(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: c.t + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  /** Move the clock forward, firing every timer that comes due. */
  const advance = (ms: number) => {
    c.t += ms;
    for (const [id, p] of [...pending]) {
      if (p.at <= c.t) {
        pending.delete(id);
        p.fn();
      }
    }
  };
  return { c, now: () => c.t, timers, advance, pending };
}

describe('watchLate', () => {
  it('fires once at its mark with the elapsed ms, and not again', async () => {
    const f = fakeTimers();
    const onLate = vi.fn(async () => {});
    const watch = watchLate({ lateAfterMs: 100_000, onLate, now: f.now, timers: f.timers });
    f.advance(99_999);
    expect(onLate).not.toHaveBeenCalled();
    expect(watch.fired).toBe(false);
    f.advance(1);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate).toHaveBeenCalledWith(100_000);
    expect(watch.fired).toBe(true);
    f.advance(200_000);
    watch.stop();
    await watch.settled();
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it('a run that stops before its mark writes no row and leaves no timer behind', async () => {
    const f = fakeTimers();
    const onLate = vi.fn(async () => {});
    const watch = watchLate({ lateAfterMs: 100_000, onLate, now: f.now, timers: f.timers });
    f.advance(40_000);
    watch.stop();
    watch.stop();
    expect(f.pending.size).toBe(0);
    f.advance(100_000);
    await watch.settled();
    expect(onLate).not.toHaveBeenCalled();
    expect(watch.fired).toBe(false);
  });

  it('a timer that fires after stop (a clear that lost the race) writes nothing', async () => {
    const f = fakeTimers();
    let due: (() => void) | undefined;
    const racy: LateTimers = { set: (fn) => ((due = fn), 1), clear: () => {} };
    const onLate = vi.fn(async () => {});
    const watch = watchLate({ lateAfterMs: 100_000, onLate, now: f.now, timers: racy });
    watch.stop();
    due!();
    await watch.settled();
    expect(onLate).not.toHaveBeenCalled();
  });

  it('measures from startedAt, so a watch started mid-run fires at the run mark', () => {
    const f = fakeTimers(50_000);
    const onLate = vi.fn(async () => {});
    watchLate({ lateAfterMs: 100_000, onLate, now: f.now, startedAt: 20_000, timers: f.timers });
    f.advance(69_999);
    expect(onLate).not.toHaveBeenCalled();
    f.advance(1);
    expect(onLate).toHaveBeenCalledWith(100_000);
  });

  it('a mark of zero or less disables the row', async () => {
    const f = fakeTimers();
    const onLate = vi.fn(async () => {});
    for (const lateAfterMs of [0, -1]) {
      const watch = watchLate({ lateAfterMs, onLate, now: f.now, timers: f.timers });
      expect(f.pending.size).toBe(0);
      f.advance(1_000_000);
      watch.stop();
      await watch.settled();
    }
    expect(onLate).not.toHaveBeenCalled();
  });

  it('a writer that throws or rejects is warned and settled, never thrown into the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const onLate of [
        async () => {
          throw new Error('log 503');
        },
        (() => {
          throw new Error('sync boom');
        }) as () => Promise<unknown>,
      ]) {
        const f = fakeTimers();
        const watch = watchLate({ lateAfterMs: 10, onLate, now: f.now, timers: f.timers, label: '[test-tick]' });
        expect(() => f.advance(10)).not.toThrow();
        watch.stop();
        await expect(watch.settled()).resolves.toBeUndefined();
        expect(watch.fired).toBe(true);
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain('[test-tick]');
    } finally {
      warn.mockRestore();
    }
  });

  it('hands the row write to waitUntil, and settled() waits for it', async () => {
    const f = fakeTimers();
    let release!: () => void;
    let written = false;
    const onLate = () =>
      new Promise<void>((r) => {
        release = () => {
          written = true;
          r();
        };
      });
    const kept: Promise<unknown>[] = [];
    const watch = watchLate({ lateAfterMs: 10, onLate, now: f.now, timers: f.timers, waitUntil: (p) => kept.push(p) });
    f.advance(10);
    expect(kept).toHaveLength(1);
    watch.stop();
    let settled = false;
    const done = watch.settled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await done;
    expect(written).toBe(true);
    await expect(kept[0]).resolves.toBeUndefined();
  });

  it('settled() resolves at once when nothing fired', async () => {
    const f = fakeTimers();
    const watch = watchLate({ lateAfterMs: 10, onLate: async () => {}, now: f.now, timers: f.timers });
    watch.stop();
    await expect(watch.settled()).resolves.toBeUndefined();
  });
});

describe('lateTimingFields', () => {
  it('names the calls still open and the slowest calls within the cap', async () => {
    const c = { t: 0 };
    const timing = newCallTiming({ deadlineAt: 5_000, now: () => c.t });
    for (let i = 0; i < 60; i++) {
      await timing.time(`d1.select:table_${i}`, async () => {
        c.t += 10;
      });
    }
    await timing.time('ms.fullWalk', async () => {
      c.t += 9_000;
    });
    let release!: () => void;
    const stuck = timing.time('data.import', () => new Promise<void>((r) => (release = r)));
    c.t += 2_000;

    const fields = lateTimingFields(timing, 600);
    const { _omitted, ...kept } = fields.calls;
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(600);
    expect(fields.calls['ms.fullWalk']).toMatchObject({ n: 1, ms: 9_000 });
    expect(_omitted).toBeGreaterThan(0);
    expect(fields.open).toEqual({ 'data.import': 2_000 });
    expect(fields.untimed).toEqual(timing.untimed());

    release();
    await stuck;
  });

  it('defaults to the 1,200-char cap the late row has used', async () => {
    const c = { t: 0 };
    const timing = newCallTiming({ deadlineAt: 0, now: () => c.t });
    for (let i = 0; i < 100; i++) {
      await timing.time(`d1.select:table_${i}`, async () => {
        c.t += 1;
      });
    }
    const { _omitted, ...kept } = lateTimingFields(timing).calls;
    const size = JSON.stringify(kept).length;
    expect(_omitted).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(1_200);
    expect(size).toBeGreaterThan(1_000);
  });
});

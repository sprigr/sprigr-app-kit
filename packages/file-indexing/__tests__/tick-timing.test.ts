/**
 * The tick call timer (sprigr-apps#4093): a tick that overran its budget has
 * to say which call ran past the deadline, by how much, and what was still
 * open when it was cut. Fake clock; calls advance it by what they "take".
 */
import { describe, expect, it } from 'vitest';
import { callsForRow, newCallTiming, timeAdapter, withCallTiming, withD1Timing } from '../src/tick-timing';

function clock(start = 1_000) {
  const c = { t: start };
  const take = (ms: number) => async () => {
    c.t += ms;
  };
  return { c, now: () => c.t, take };
}

describe('newCallTiming', () => {
  it('counts calls, total and slowest ms, and only the part past the deadline as late', async () => {
    const { c, now, take } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 10_000, now });
    await timing.time('ms.fullWalk', take(8_000));
    await timing.time('ms.fullWalk', take(6_000)); // starts at 8 s, ends at 14 s: 4 s late
    await timing.time('data.import', take(3_000)); // wholly past the deadline
    expect(timing.calls['ms.fullWalk']).toEqual({ n: 2, ms: 14_000, max: 8_000, late: 4_000 });
    expect(timing.calls['data.import']).toEqual({ n: 1, ms: 3_000, max: 3_000, late: 3_000 });
  });

  it('a call that throws is still counted', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 1_000, now });
    await expect(
      timing.time('ms.downloadBinary', async () => {
        c.t += 2_000;
        throw new Error('graph 503');
      }),
    ).rejects.toThrow('graph 503');
    expect(timing.calls['ms.downloadBinary']).toEqual({ n: 1, ms: 2_000, max: 2_000, late: 1_000 });
  });

  it('open() names the calls still running and how long the longest has run', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 1_000, now });
    let release!: () => void;
    const pending = timing.time('ms.resolvePrincipals', () => new Promise<void>((r) => (release = r)));
    c.t += 4_500;
    expect(timing.open()).toEqual({ 'ms.resolvePrincipals': 4_500 });
    release();
    await pending;
    expect(timing.open()).toEqual({});
  });

  it('untimed() is the part of a step no timed call covered, counting overlapping calls once', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 60_000, now });
    await timing.time('step.pass', async () => {
      c.t += 1_000; // between calls
      let a!: () => void;
      let b!: () => void;
      const p1 = timing.time('ms.refetchEntry', () => new Promise<void>((r) => (a = r)));
      const p2 = timing.time('ms.refetchEntry', () => new Promise<void>((r) => (b = r)));
      c.t += 3_000; // both open: 3 s covered, not 6
      a();
      b();
      await Promise.all([p1, p2]);
      c.t += 2_000; // between calls
    });
    expect(timing.untimed()).toEqual({ 'step.pass': 3_000 });
    expect(timing.calls['ms.refetchEntry']).toMatchObject({ n: 2, ms: 6_000 });
  });
});

describe('timeAdapter', () => {
  it('times the adapter calls it has under the prefix, keeps `this`, and leaves the rest alone', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 60_000, now });
    const adapter = {
      pages: 3,
      async fullWalk() {
        c.t += 500;
        return this.pages;
      },
      label() {
        return 'not timed';
      },
    };
    const timed = timeAdapter(adapter, timing, 'ms');
    expect(await timed.fullWalk()).toBe(3);
    expect(timed.label()).toBe('not timed');
    expect(Object.keys(timing.calls)).toEqual(['ms.fullWalk']);
    expect('downloadBinary' in timed).toBe(false);
  });
});

describe('withCallTiming', () => {
  it('times the platform files, data and emit calls and returns their results', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 60_000, now });
    const env = {
      DB: 'kept',
      SPRIGR: {
        data: { import: async (rows: unknown[]) => ((c.t += 700), { indexed: rows.length }) },
        emit: async () => ((c.t += 200), { ok: true }),
        log: async () => ({ ok: true }),
      },
    };
    const timed = withCallTiming(env, timing);
    expect(await timed.SPRIGR.data.import([1, 2])).toEqual({ indexed: 2 });
    expect(await timed.SPRIGR.emit()).toEqual({ ok: true });
    await timed.SPRIGR.log();
    expect(timed.DB).toBe('kept');
    expect(timing.calls['data.import']).toMatchObject({ n: 1, ms: 700 });
    expect(timing.calls['emit']).toMatchObject({ n: 1, ms: 200 });
    expect(timing.calls['log']).toBeUndefined();
  });

  it('an env with no SPRIGR is returned as is', () => {
    const timing = newCallTiming({ deadlineAt: 0 });
    const env = { DB: 'x' };
    expect(withCallTiming(env, timing)).toBe(env);
  });
});

describe('withD1Timing', () => {
  it('names each statement by verb and table, through bind, and hands batch the real statements', async () => {
    const { c, now } = clock();
    const timing = newCallTiming({ deadlineAt: c.t + 60_000, now });
    interface Stmt {
      sql: string;
      bind(...args: unknown[]): Stmt;
      first(): Promise<unknown>;
      run(): Promise<unknown>;
    }
    const real: object[] = [];
    const stmt = (sql: string): Stmt => {
      const s: Stmt = {
        sql,
        bind: () => s,
        first: async () => ((c.t += 40), { sql }),
        run: async () => ((c.t += 60), { success: true }),
      };
      real.push(s);
      return s;
    };
    const db = {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Stmt[]) => ((c.t += 90), stmts.map((s) => real.includes(s))),
    };
    const timed = withD1Timing({ DB: db }, timing);
    await timed.DB.prepare('SELECT * FROM ms_file_index_lease WHERE k = ?').bind('a').first();
    await timed.DB.prepare('UPDATE ms_file_indexing SET cursor = ?').bind('c').run();
    const viaBatch = await timed.DB.batch([timed.DB.prepare('INSERT INTO ms_pending (id) VALUES (?)').bind(1)]);
    expect(viaBatch).toEqual([true]);
    expect(timing.calls['d1.first:ms_file_index_lease']).toMatchObject({ n: 1, ms: 40 });
    expect(timing.calls['d1.run:ms_file_indexing']).toMatchObject({ n: 1, ms: 60 });
    expect(timing.calls['d1.batch']).toMatchObject({ n: 1, ms: 90 });
  });
});

describe('callsForRow', () => {
  it('keeps the latest calls first within the cap and counts the rest', () => {
    const calls = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`ms.call${i}`, { n: 1, ms: 100 + i, max: 100 + i, late: i }]),
    );
    const row = callsForRow(calls, 400);
    expect(JSON.stringify(row).length).toBeLessThanOrEqual(400 + 20);
    expect(Object.keys(row)[0]).toBe('ms.call39');
    expect(row._omitted).toBe(40 - (Object.keys(row).length - 1));
  });

  it('keeps everything that fits and adds no _omitted', () => {
    const row = callsForRow({ 'ms.fullWalk': { n: 1, ms: 5, max: 5, late: 0 } });
    expect(row).toEqual({ 'ms.fullWalk': { n: 1, ms: 5, max: 5, late: 0 } });
  });
});

/** A clock that moves only when every pending task is asleep. */
export class VirtualTime {
  t = 1_000_000;
  private timers: Array<{ at: number; seq: number; wake: () => void }> = [];
  private seq = 0;
  now = (): number => this.t;
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => this.timers.push({ at: this.t + ms, seq: this.seq++, wake }));
  }
  advance(ms: number): void {
    this.t += ms;
  }
  /** Settle `p`, moving the clock to the next timer whenever nothing else can run. */
  async run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let guard = 0; guard < 1_000_000; guard++) {
      // sql.js answers synchronously behind a promise: a macrotask turn lets
      // every microtask chain run to its next sleep.
      await new Promise<void>((r) => setImmediate(r));
      if (settled) return p;
      if (this.timers.length === 0) {
        await new Promise<void>((r) => setImmediate(r));
        if (settled) return p;
        throw new Error('virtual time stalled: nothing is asleep and the task has not settled');
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const at = this.timers[0]!.at;
      this.t = Math.max(this.t, at);
      const due = this.timers.filter((x) => x.at <= this.t);
      this.timers = this.timers.filter((x) => x.at > this.t);
      for (const d of due) d.wake();
    }
    throw new Error('virtual time: too many steps');
  }
}

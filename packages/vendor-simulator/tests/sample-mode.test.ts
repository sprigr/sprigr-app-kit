import { describe, expect, it, vi } from 'vitest';
import {
  createSampleStore,
  createSampleSwitch,
  sampleAwareFetch,
  SampleModeUnknownError,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const FLAG_ROW = { resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 };
const FLAG_READ = /^SELECT id FROM sample_objects WHERE resource = \? AND id = \?$/;

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function switchOn(rows = [FLAG_ROW]) {
  const d1 = makeMockD1(TABLE, rows);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  return { d1, store, sw: createSampleSwitch(store) };
}

const flagReads = (statements: string[]) => statements.filter((s) => FLAG_READ.test(s)).length;

describe('the per-install sample flag', () => {
  it('reads on when the flag row is present', async () => {
    const { sw } = switchOn();
    expect(await sw.mode()).toBe('on');
  });

  it('reads off when there is no flag row (never set)', async () => {
    const { sw } = switchOn([]);
    expect(await sw.mode()).toBe('off');
  });

  it('reads unknown when the read fails', async () => {
    const { d1, sw } = switchOn();
    d1.failOn = FLAG_READ;
    expect(await sw.mode()).toBe('unknown');
  });

  it('reads the flag at most once per switch, failures included', async () => {
    const on = switchOn();
    await on.sw.mode();
    await on.sw.mode();
    expect(flagReads(on.d1.statements)).toBe(1);

    const failed = switchOn();
    failed.d1.failOn = FLAG_READ;
    await failed.sw.mode();
    await failed.sw.mode();
    expect(flagReads(failed.d1.statements)).toBe(1);
  });

  it('refuses a table name that is not a plain identifier', () => {
    const d1 = makeMockD1(TABLE);
    expect(() => createSampleStore({ db: d1.db, table: 'x; DROP TABLE y' })).toThrow();
  });
});

describe('sampleAwareFetch routes by the flag', () => {
  const url = 'https://vendor.example/api/items';

  function harness(rows = [FLAG_ROW]) {
    const { d1, sw } = switchOn(rows);
    const network = vi.fn<FetchImpl>(async () => new Response('network', { status: 200 }));
    const simulated = vi.fn<FetchImpl>(async () => new Response('simulated', { status: 200 }));
    const fetchImpl = sampleAwareFetch({ sampleSwitch: sw, simulator: { fetch: simulated }, network });
    return { d1, network, simulated, fetchImpl };
  }

  it('on: the simulator answers and the network is never called', async () => {
    const h = harness();
    const res = await h.fetchImpl(url, { method: 'POST', body: '{}' });
    expect(await res.text()).toBe('simulated');
    expect(h.simulated).toHaveBeenCalledTimes(1);
    expect(h.network).not.toHaveBeenCalled();
  });

  it('off: the network answers with the same request and the simulator is never called', async () => {
    const h = harness([]);
    const init = { method: 'GET' };
    const res = await h.fetchImpl(url, init);
    expect(await res.text()).toBe('network');
    expect(h.network).toHaveBeenCalledWith(url, init);
    expect(h.simulated).not.toHaveBeenCalled();
  });

  it('unknown: refused, with no network call and no simulator answer', async () => {
    const h = harness();
    h.d1.failOn = FLAG_READ;
    const err = await h.fetchImpl(url, { method: 'GET' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SampleModeUnknownError);
    expect((err as SampleModeUnknownError).code).toBe('sample_mode_unknown');
    expect(h.network).not.toHaveBeenCalled();
    expect(h.simulated).not.toHaveBeenCalled();
  });

  it('several fetches in one invocation read the flag once', async () => {
    const h = harness();
    await h.fetchImpl(url);
    await h.fetchImpl(url);
    await h.fetchImpl(url);
    expect(flagReads(h.d1.statements)).toBe(1);
  });
});

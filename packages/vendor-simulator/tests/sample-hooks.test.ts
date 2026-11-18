import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSampleSwitch,
  createSimulator,
  plainDialect,
  sampleLoadHook,
  sampleRemoveHook,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type SampleSeed,
} from '../src/index';
import { makeMockD1, type MockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const ARGS = { install_id: 'install-1', company_id: 'company-1' };

const SEED: SampleSeed = { items: { idField: 'ItemID', items: [{ ItemID: 'i1', Name: 'Bolt' }] } };
const DIALECT = plainDialect({
  routes: [
    { method: 'GET', path: '/items', op: 'list', resource: 'items' },
    { method: 'POST', path: '/items', op: 'create', resource: 'items' },
  ],
});

interface Env {
  d1: MockD1;
}

const storeFor = (env: Env) => createSampleStore({ db: env.d1.db, table: TABLE });
const load = sampleLoadHook<Env>(storeFor);
const remove = sampleRemoveHook<Env>(storeFor);

/** A fresh switch, as the next invocation would make. */
const modeOf = (env: Env) => createSampleSwitch(storeFor(env)).mode();

describe('on_sample_load', () => {
  it('turns the install on', async () => {
    const env = { d1: makeMockD1(TABLE) };
    expect(await modeOf(env)).toBe('off');
    expect(await load(ARGS, env)).toEqual({ ok: true });
    expect(await modeOf(env)).toBe('on');
  });

  it('is safe to call again and keeps writes already made', async () => {
    const env = { d1: makeMockD1(TABLE) };
    await load(ARGS, env);
    const sim = createSimulator({ seed: SEED, dialect: DIALECT, store: storeFor(env) });
    await sim.fetch('https://vendor.example/items', { method: 'POST', body: JSON.stringify({ Name: 'Hook' }) });
    expect(await load(ARGS, env)).toEqual({ ok: true });
    expect(await modeOf(env)).toBe('on');
    const list = (await (await sim.fetch('https://vendor.example/items')).json()) as unknown[];
    expect(list.length).toBe(2);
  });

  it('a failed write never answers ok', async () => {
    const env = { d1: makeMockD1(TABLE) };
    env.d1.failOn = /^INSERT INTO/;
    await expect(load(ARGS, env)).rejects.toThrow();
  });
});

describe('on_sample_remove', () => {
  it('deletes the flag and every write in one handler', async () => {
    const env = {
      d1: makeMockD1(TABLE, [
        { resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 },
        { resource: 'items', id: 'i9', body: '{"ItemID":"i9","Name":"Hook"}', deleted: 0 },
        { resource: 'items', id: 'i1', body: '{}', deleted: 1 },
      ]),
    };
    expect(await remove(ARGS, env)).toEqual({ ok: true });
    expect(env.d1.rows.size).toBe(0);
    expect(await modeOf(env)).toBe('off');
  });

  it('is safe to call again on an install that is already off', async () => {
    const env = { d1: makeMockD1(TABLE) };
    expect(await remove(ARGS, env)).toEqual({ ok: true });
  });

  it('a failed delete never answers ok, and the install stays on', async () => {
    const env = { d1: makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]) };
    env.d1.failOn = /^DELETE FROM/;
    await expect(remove(ARGS, env)).rejects.toThrow();
    env.d1.failOn = null;
    expect(await modeOf(env)).toBe('on');
  });
});

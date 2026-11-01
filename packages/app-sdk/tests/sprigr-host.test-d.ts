/**
 * #247: the env.SPRIGR namespaces type the keys the platform reads. A wrong
 * key is dropped on the wire, so these assert the compiler refuses it.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { SprigrHostApis } from '../src/index';

declare const sprigr: SprigrHostApis;

describe('SprigrHostApis', () => {
  it('exposes every namespace the wrapper serves', () => {
    expectTypeOf<keyof SprigrHostApis>().toEqualTypeOf<
      'usage' | 'acl' | 'connect' | 'integrations' | 'run_workflow' | 'browser' | 'schedules' | 'store' | 'collections' | 'fulfillment_services' | 'ftp'
    >();
  });

  it('collections take snake_case keys and the real merge policies', () => {
    sprigr.collections.query({ collection: 'c', hits_per_page: 10, sort_by: 'name' });
    sprigr.collections.ingest({ collection: 'c', records: [], merge_policy: 'conflict_hold' });
    sprigr.collections.clear({ collection: 'c', cursor: null, max_records: 500 });
    // @ts-expect-error camelCase is dropped by the route
    sprigr.collections.query({ collection: 'c', hitsPerPage: 10 });
    // @ts-expect-error source_priority is not a policy yet
    sprigr.collections.ingest({ collection: 'c', records: [], merge_policy: 'source_priority' });
  });

  it('schedules.create needs exactly one of cron or fireAt and refuses pipe tasks', () => {
    sprigr.schedules.create({ name: 'n', cron: '0 * * * *', prompt: 'p' });
    sprigr.schedules.create({ name: 'n', fireAt: '2026-11-02T00:00:00Z', taskType: 'reminder', reminderMessage: 'r' });
    // @ts-expect-error both triggers
    sprigr.schedules.create({ name: 'n', cron: '0 * * * *', fireAt: '2026-11-02T00:00:00Z' });
    // @ts-expect-error no trigger
    sprigr.schedules.create({ name: 'n', prompt: 'p' });
    // @ts-expect-error pipe is refused
    sprigr.schedules.create({ name: 'n', cron: '0 * * * *', taskType: 'pipe' });
  });

  it('store values are strings and get resolves null for a miss', () => {
    expectTypeOf(sprigr.store.get('k')).resolves.toEqualTypeOf<string | null>();
    expectTypeOf(sprigr.store.list()).resolves.toEqualTypeOf<string[]>();
    // @ts-expect-error the store holds strings only
    sprigr.store.put('k', { a: 1 });
  });

  it('ftp and connect use the wire spellings', () => {
    sprigr.ftp.upload({ host: 'h', protocol: 'ftps', username: 'u', password: 'p', filename: 'f', content_base64: 'YQ==' });
    // @ts-expect-error sftp is not supported
    sprigr.ftp.upload({ host: 'h', protocol: 'sftp', username: 'u', password: 'p', filename: 'f', content_base64: 'YQ==' });
    sprigr.connect.complete({ viewer_token: 'v', bind: { kind: 'agent', agent_id: 'a' }, account: { email: 'e' } });
    // @ts-expect-error an agent bind needs agent_id
    sprigr.connect.complete({ viewer_token: 'v', bind: { kind: 'agent', agentId: 'a' }, account: { email: 'e' } });
  });

  it('run_workflow resolves a result instead of throwing', () => {
    expectTypeOf(sprigr.run_workflow('wf', { timeout_ms: 500 })).resolves.toHaveProperty('ok');
    expectTypeOf(sprigr.fulfillment_services.update()).resolves.toBeNever();
  });
});

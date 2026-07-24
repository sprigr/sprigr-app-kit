import { describe, expect, it } from 'vitest';
import { makeWebhookRegistry } from '../src/webhook-registry';
import { makeMockD1 } from './mock-d1';

describe('makeWebhookRegistry', () => {
  it('rejects a non-identifier table name', () => {
    const { db } = makeMockD1();
    expect(() => makeWebhookRegistry({ db, table: 'foo; DROP' })).toThrow(
      /not a plain SQL identifier/,
    );
  });

  it('find returns null when nothing is registered', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    expect(await reg.find('orders/create')).toBeNull();
  });

  it('record then find round-trips', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.record('orders/create', 'gid://Shop/Webhook/123', 'https://example.com/webhook');
    const row = await reg.find('orders/create');
    expect(row).not.toBeNull();
    expect(row!.topic).toBe('orders/create');
    expect(row!.subscriptionId).toBe('gid://Shop/Webhook/123');
    expect(row!.callbackUrl).toBe('https://example.com/webhook');
  });

  it('record upserts (replaces subscription_id + callback_url)', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.record('orders/create', 'sub-1', 'https://old.example.com');
    await reg.record('orders/create', 'sub-2', 'https://new.example.com');
    const row = await reg.find('orders/create');
    expect(row!.subscriptionId).toBe('sub-2');
    expect(row!.callbackUrl).toBe('https://new.example.com');
  });

  it('remove deletes the row', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.record('orders/create', 'sub-1', 'https://x');
    await reg.remove('orders/create');
    expect(await reg.find('orders/create')).toBeNull();
  });

  it('remove on a missing topic is a no-op', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.remove('orders/create');
    expect(await reg.find('orders/create')).toBeNull();
  });

  it('list returns every row sorted by topic', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.record('products/create', 'p1', 'https://x');
    await reg.record('orders/create', 'o1', 'https://x');
    await reg.record('orders/cancelled', 'oc1', 'https://x');
    const all = await reg.list();
    expect(all.map((r) => r.topic)).toEqual([
      'orders/cancelled',
      'orders/create',
      'products/create',
    ]);
  });

  it('list returns [] when empty', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    expect(await reg.list()).toEqual([]);
  });

  it('record then list shows the new topic', async () => {
    const { db } = makeMockD1();
    const reg = makeWebhookRegistry({ db, table: 'webhook_subs' });
    await reg.record('orders/create', 'sub-1', 'https://x');
    const all = await reg.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.topic).toBe('orders/create');
  });

  it('two registries against different tables do not collide', async () => {
    const { db } = makeMockD1();
    const shopify = makeWebhookRegistry({ db, table: 'shopify_subs' });
    const procore = makeWebhookRegistry({ db, table: 'procore_subs' });
    await shopify.record('orders/create', 'shopify-1', 'https://x');
    await procore.record('rfis', 'procore-1', 'https://y');
    expect((await shopify.find('orders/create'))!.subscriptionId).toBe('shopify-1');
    expect((await procore.find('rfis'))!.subscriptionId).toBe('procore-1');
    expect(await shopify.find('rfis')).toBeNull();
  });
});

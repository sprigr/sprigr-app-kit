import { describe, expect, it, vi } from 'vitest';
import { archiveOfferRefusal, refuseWithoutForce } from '../../src/write-protection/refuse-without-force';

describe('refuseWithoutForce', () => {
  const opts = { resource: 'product', archiveAction: 'shopify_update_product', idKeys: ['product_id', 'id'] };

  it('refuses an un-forced delete with the archive offer and writes nothing', async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    const wrapped = refuseWithoutForce('shopify_delete_product', inner, opts);
    const r = (await wrapped({ product_id: 'gid://1' }, {})) as Record<string, unknown>;
    expect(inner).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, deleted: false, archive_available: true, record_id: 'gid://1', archive_action: 'shopify_update_product' });
    expect(String(r.note)).toMatch(/force: true/);
  });

  it('proceeds on force: true and strips force before the inner handler sees it', async () => {
    const inner = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, seen: args }));
    const wrapped = refuseWithoutForce('shopify_delete_product', inner, opts);
    const r = (await wrapped({ product_id: 'gid://1', force: true }, {})) as { seen: Record<string, unknown> };
    expect(r.seen).toEqual({ product_id: 'gid://1' });
  });

  it('a truthy non-boolean force does not count', async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    await refuseWithoutForce('x', inner, opts)({ id: 1, force: 'yes' }, {});
    expect(inner).not.toHaveBeenCalled();
  });

  it('archiveOfferRefusal includes a deep link only when the app can build one', () => {
    const withLink = archiveOfferRefusal('delete_job', { job_id: 42 }, { ...opts, idKeys: ['job_id'], link: (_a, id) => `https://x/jobs/${id}` });
    expect(withLink.link).toBe('https://x/jobs/42');
    expect(archiveOfferRefusal('delete_job', { job_id: 42 }, { ...opts, idKeys: ['job_id'] }).link).toBeUndefined();
  });
});

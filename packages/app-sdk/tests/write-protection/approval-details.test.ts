/**
 * `_approval.details` (sprigr-team decision 0360): technical context the card
 * shows collapsed. It reaches the envelope as written and never moves the
 * hash, so changing what the card explains cannot void a tap.
 */
import { describe, expect, it, vi } from 'vitest';
import { requireApproval, type ApprovalSpec } from '../../src/write-protection/require-approval';

const handlers = { delete_product: vi.fn(async () => ({ ok: true })) };
const gate = (details?: string) => {
  const spec: ApprovalSpec = {
    keys: ['id'],
    describe: (target) => ({ question: `Delete ${target}?`, header: 'Shop', ...(details ? { details } : {}) }),
  };
  return requireApproval(handlers, { delete_product: spec }, { scope: 'test', resolveConnection: async () => '' });
};

async function envelope(details?: string) {
  const r = (await gate(details).delete_product!({ id: 'gid://Product/7' }, {})) as {
    _approval: { hash: string; details?: string };
  };
  return r._approval;
}

describe('_approval.details', () => {
  it('reaches the envelope from describe and leaves the hash alone', async () => {
    const withDetails = await envelope('id=gid://Product/7\nvariants=3');
    const without = await envelope();
    expect(withDetails.details).toBe('id=gid://Product/7\nvariants=3');
    expect(without).not.toHaveProperty('details');
    expect(withDetails.hash).toBe(without.hash);
  });
});

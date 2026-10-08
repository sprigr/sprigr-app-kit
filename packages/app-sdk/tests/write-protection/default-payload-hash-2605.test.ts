/**
 * A spec with no `hash` binds the grant to the payload too (sprigr-apps#2605).
 *
 * Before, a hash-less spec hashed only the target id and the connection, so
 * Shopify's `shopify_create_refund` hashed the same for a 10.00 refund and a
 * 250.00 one on the same order, and the platform keyed the grant on that
 * hash. Now the wrapper appends a canonical form of every remaining
 * argument: not the `keys` fields (already in the hash as the id), not the
 * attestation flags, and not `connectionArgs` (already in the hash as the
 * RESOLVED connection, and usually omitted by the model on the retry). A call
 * whose only arguments are those keeps exactly the old hash.
 */
import { describe, expect, it, vi } from 'vitest';
import { requireApproval, dispatcherApproval, type ApprovalSpec, type RequireApprovalOptions } from '../../src/write-protection/require-approval';
import { approvalHash } from '../../src/write-protection/approval-hash';

interface Env { defaultStore: string }

function opts(overrides: Partial<RequireApprovalOptions<Env>> = {}): RequireApprovalOptions<Env> {
  return {
    scope: 'test',
    resolveConnection: async (env, args) => (typeof args.store === 'string' ? `${args.store}.myshopify.com` : env.defaultStore),
    connectionArgs: ['store'],
    ...overrides,
  };
}

const refundSpec: ApprovalSpec<Env> = {
  keys: ['order_id'],
  describe: (target) => ({ question: `Refund on ${target}?`, header: 'Shop' }),
};

const handlers = { create_refund: vi.fn(async () => ({ ok: true })) };
const env: Env = { defaultStore: 'us.myshopify.com' };

async function hashOf(args: Record<string, unknown>, o = opts()): Promise<string> {
  const gated = requireApproval(handlers, { create_refund: refundSpec }, o);
  const r = (await gated.create_refund!(args, env)) as { _approval: { hash: string } };
  return r._approval.hash;
}

describe('default payload hash for a spec with no hash (#2605)', () => {
  it('a different amount moves the hash', async () => {
    const ten = await hashOf({ order_id: 'gid://Order/1001', refund_amount: '10.00' });
    const big = await hashOf({ order_id: 'gid://Order/1001', refund_amount: '250.00' });
    expect(ten).not.toBe(big);
  });

  it('different nested line items move the hash; key order does not', async () => {
    const a = await hashOf({ order_id: 'o1', refund_line_items: [{ line_item_id: 'l1', quantity: 1 }] });
    const b = await hashOf({ order_id: 'o1', refund_line_items: [{ line_item_id: 'l1', quantity: 3 }] });
    const aReordered = await hashOf({ refund_line_items: [{ quantity: 1, line_item_id: 'l1' }], order_id: 'o1' });
    expect(a).not.toBe(b);
    expect(a).toBe(aReordered);
  });

  it('confirm, _approval_granted and the connection args do not move it', async () => {
    const plain = await hashOf({ order_id: 'o1', refund_amount: '10.00' });
    const withFlags = await hashOf({ order_id: 'o1', refund_amount: '10.00', confirm: true });
    const withStore = await hashOf({ order_id: 'o1', refund_amount: '10.00', store: 'us' });
    expect(withFlags).toBe(plain);
    // `store: 'us'` resolves to the same default connection, so it is the same operation.
    expect(withStore).toBe(plain);
  });

  it('a call carrying only the id and the connection keeps exactly the old hash', async () => {
    expect(await hashOf({ order_id: 'o1', store: 'eu' })).toBe(approvalHash('o1', 'eu.myshopify.com'));
  });

  it('an explicit spec.hash still replaces the default entirely', async () => {
    const gated = requireApproval(handlers, { create_refund: { ...refundSpec, hash: () => ['fixed'] } }, opts());
    const r = (await gated.create_refund!({ order_id: 'o1', refund_amount: '10.00' }, env)) as { _approval: { hash: string } };
    expect(r._approval.hash).toBe(approvalHash('o1', 'us.myshopify.com', 'fixed'));
  });

  it('applies to a dispatcher action too', async () => {
    const gate = dispatcherApproval<Env>({ refund: refundSpec }, opts());
    const ask = async (input: Record<string, unknown>) =>
      ((await gate.run('refund', { action: 'refund', input }, env, async () => ({ ok: true }))) as { _approval: { hash: string } })._approval.hash;
    expect(await ask({ order_id: 'o1', refund_amount: '10.00' })).not.toBe(await ask({ order_id: 'o1', refund_amount: '99.00' }));
  });
});

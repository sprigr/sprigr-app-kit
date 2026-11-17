/**
 * order_source 1.13.0: a money field the source could not read may be left
 * out of the record, but only when the order names it in
 * `amounts_unreadable` (sprigr/sprigr-apps#5418). Absent and not named is
 * still a contract failure, and so is a value that is also named.
 */

import { describe, expect, it } from 'vitest';
import { runOrderSourceConformance } from '../src/order-source';
import { formatReport } from '../src/report';
import { makeOrderSourceAdapter } from './fixtures';

const NOW = '2026-11-18T00:00:00Z';

type Rec = Record<string, unknown>;

const ORDER: Rec = {
  order_id: '',
  source_adapter: 'tiny-src',
  source_ref: 'src_conformance_order',
  source_number: 'PY1',
  channel: 'shopify',
  status: 'received',
  placed_at: NOW,
  currency: 'AUD',
  total_minor: 2500,
  customer_email: 'buyer@example.test',
  ship_to_json: '{"line1":"1 Test Street","city":"Brisbane","country":"AU"}',
  tags_json: '[]',
  hold_reason: '',
  updated_at: NOW,
  shipping_minor: 1000,
  discount_minor: 0,
};

const LINE: Rec = {
  order_id: '',
  line_id: 'ln_1',
  source_line_ref: 'sl_conformance_1',
  sku: 'CONF-SKU-1',
  title: 'Conformance widget',
  quantity: 2,
  unit_price_minor: 1250,
  currency: 'AUD',
  requires_shipping: true,
};

const without = (o: Rec, ...keys: string[]): Rec => {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
};

/** The get_order shape check for an adapter answering this order and lines. */
async function shapeOf(order: Rec, lines: Rec[] = [LINE]) {
  const { handlers } = makeOrderSourceAdapter({ tiny_src_get_order: () => ({ found: true, order, lines }) });
  const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
  const shape = report.checks.find((c) => c.name === 'get_order.output_shape');
  return { ok: shape?.ok, detail: shape?.detail ?? '', failed: report.checks.filter((c) => !c.ok).map((c) => c.name), report };
}

describe('order total_minor', () => {
  it('may be absent when amounts_unreadable names it', async () => {
    const s = await shapeOf({ ...without(ORDER, 'total_minor'), amounts_unreadable: ['total_minor'] });
    expect(s.failed, formatReport(s.report)).toEqual([]);
  });

  it('is still required when amounts_unreadable is absent or does not name it', async () => {
    for (const order of [without(ORDER, 'total_minor'), { ...without(ORDER, 'total_minor'), amounts_unreadable: [] }]) {
      const s = await shapeOf(order);
      expect(s.ok).toBe(false);
      expect(s.detail).toMatch(/total_minor/);
    }
  });

  it('may not carry a value and be named as unreadable', async () => {
    const s = await shapeOf({ ...ORDER, amounts_unreadable: ['total_minor'] });
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/total_minor/);
    expect(s.detail).toMatch(/amounts_unreadable/);
  });
});

describe('order_line unit_price_minor', () => {
  it('may be absent when the order names that line in amounts_unreadable', async () => {
    const s = await shapeOf({ ...ORDER, amounts_unreadable: ['lines.ln_1.unit_price_minor'] }, [without(LINE, 'unit_price_minor')]);
    expect(s.failed, formatReport(s.report)).toEqual([]);
  });

  it('is still required when the order does not name that line', async () => {
    for (const named of [undefined, [], ['lines.ln_2.unit_price_minor']]) {
      const order = named === undefined ? ORDER : { ...ORDER, amounts_unreadable: named };
      const s = await shapeOf(order, [without(LINE, 'unit_price_minor')]);
      expect(s.ok).toBe(false);
      expect(s.detail).toMatch(/unit_price_minor/);
    }
  });

  it('may not carry a value and be named as unreadable', async () => {
    const s = await shapeOf({ ...ORDER, amounts_unreadable: ['lines.ln_1.unit_price_minor'] });
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/unit_price_minor/);
  });
});

describe('order shipping_minor and discount_minor (optional since 1.2.0)', () => {
  it('may be absent and named, and may be absent and unnamed as before 1.13.0', async () => {
    const named = await shapeOf({
      ...without(ORDER, 'shipping_minor', 'discount_minor'),
      amounts_unreadable: ['shipping_minor', 'discount_minor'],
    });
    expect(named.failed, formatReport(named.report)).toEqual([]);
    const unnamed = await shapeOf(without(ORDER, 'shipping_minor', 'discount_minor'));
    expect(unnamed.failed, formatReport(unnamed.report)).toEqual([]);
  });

  it('may not carry a value and be named as unreadable', async () => {
    for (const field of ['shipping_minor', 'discount_minor']) {
      const s = await shapeOf({ ...ORDER, amounts_unreadable: [field] });
      expect(s.ok).toBe(false);
      expect(s.detail).toContain(field);
    }
  });

  it('must be an integer when present', async () => {
    const s = await shapeOf({ ...ORDER, shipping_minor: 10.5 });
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/shipping_minor must be an integer/);
  });
});

describe('amounts_unreadable itself', () => {
  it('is optional, and [] on a fully read order passes', async () => {
    expect((await shapeOf({ ...ORDER, amounts_unreadable: [] })).failed).toEqual([]);
    expect((await shapeOf(ORDER)).failed).toEqual([]);
  });

  it('names only the four money fields, and only lines the answer returned', async () => {
    for (const bad of [['tax_minor'], ['lines.ln_9.unit_price_minor'], ['lines.ln_1.quantity'], [42]]) {
      const s = await shapeOf({ ...ORDER, amounts_unreadable: bad });
      expect(s.ok, JSON.stringify(bad)).toBe(false);
      expect(s.detail).toMatch(/amounts_unreadable/);
    }
  });
});

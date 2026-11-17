/**
 * order_source 1.13.0: a source may leave a money field out of an order
 * record only when it could not read it, and then it names the field in
 * `order.amounts_unreadable`. Leaving it out unnamed, or naming a field that
 * carries a value, both fail. Null is never "unreadable": a 1.12.0 hub reads
 * it through Number(), which turns null into 0.
 */

import { isPlainObject } from './shape';

const ORDER_REQUIRED_AMOUNTS = ['total_minor'] as const;
const ORDER_OPTIONAL_AMOUNTS = ['shipping_minor', 'discount_minor'] as const;
const LINE_AMOUNT = 'unit_price_minor';

const lineName = (lineId: string) => `lines.${lineId}.${LINE_AMOUNT}`;

/**
 * Checks the amounts rules on a get_order output (or any `{ order, lines }`
 * pair). The field kinds themselves (integer, string array) are the shape
 * check's job; this only checks presence against `amounts_unreadable`.
 */
export function checkOrderAmounts(value: Record<string, unknown>, path = 'result'): string[] {
  const order = value.order;
  if (value.found !== true || !isPlainObject(order)) return [];
  const listed = order.amounts_unreadable;
  const names = Array.isArray(listed) ? listed.filter((n): n is string => typeof n === 'string') : [];
  const named = new Set(names);
  const issues: string[] = [];

  for (const field of ORDER_REQUIRED_AMOUNTS) {
    if (order[field] === undefined && !named.has(field)) {
      issues.push(`${path}.order.${field} is required by the contract and is missing; leave it out only when order.amounts_unreadable names "${field}"`);
    }
  }
  for (const field of [...ORDER_REQUIRED_AMOUNTS, ...ORDER_OPTIONAL_AMOUNTS]) {
    if (order[field] !== undefined && named.has(field)) {
      issues.push(`${path}.order.${field} carries a value and is also named in order.amounts_unreadable; an unreadable amount is left out of the record`);
    }
  }

  const allowed = new Set<string>([...ORDER_REQUIRED_AMOUNTS, ...ORDER_OPTIONAL_AMOUNTS]);
  const lines = Array.isArray(value.lines) ? value.lines : [];
  lines.forEach((line, i) => {
    if (!isPlainObject(line) || typeof line.line_id !== 'string') return;
    const name = lineName(line.line_id);
    allowed.add(name);
    if (line[LINE_AMOUNT] === undefined && !named.has(name)) {
      issues.push(`${path}.lines[${i}].${LINE_AMOUNT} is required by the contract and is missing; leave it out only when order.amounts_unreadable names "${name}"`);
    }
    if (line[LINE_AMOUNT] !== undefined && named.has(name)) {
      issues.push(`${path}.lines[${i}].${LINE_AMOUNT} carries a value and is also named in order.amounts_unreadable as "${name}"; an unreadable amount is left out of the record`);
    }
  });

  names.forEach((n) => {
    if (!allowed.has(n)) {
      issues.push(`${path}.order.amounts_unreadable names "${n}", which is not total_minor, shipping_minor, discount_minor or lines.<line_id>.${LINE_AMOUNT} for a line this answer returned`);
    }
  });
  return issues;
}

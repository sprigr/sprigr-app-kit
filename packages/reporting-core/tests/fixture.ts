import { ReportingError, validateModel, type ReportingModel } from '../src';

/** A made-up retailer. Nothing here is a real tenant's table or column. */
export const MODEL_JSON = {
  model_version: 1,
  streams: [
    {
      key: 'sales', label: 'Sales', table: 'sales_lines', date: 'sale_date',
      dimension_keys: { product: 'product_code', branch: 'branch_code' },
      columns: [{ key: 'doc', label: 'Document', column: 'doc_no' }],
    },
    { key: 'orders', label: 'Orders', table: 'order_lines', date: 'order_date', dimension_keys: { product: 'product_code' } },
  ],
  dimensions: [
    { key: 'product', label: 'Product', table: 'products', code: 'code', name: 'name', properties: [{ key: 'brand', label: 'Brand', column: 'brand' }] },
    { key: 'department', label: 'Department', table: 'departments', code: 'code', name: 'name', via: { dimension: 'product', column: 'dept' } },
    { key: 'branch', label: 'Branch' },
    { key: 'customer', label: 'Customer' },
  ],
  measures: [
    { key: 'sales', label: 'Sales', agg: 'sum', column: 'amount', format: 'currency' },
    { key: 'cost', label: 'Cost', agg: 'sum', column: 'cost', format: 'currency' },
    { key: 'qty', label: 'Qty', agg: 'sum', column: 'qty', format: 'integer' },
    { key: 'lines', label: 'Lines', agg: 'count' },
    { key: 'profit', label: 'Profit', formula: 'sales - cost', format: 'currency' },
    { key: 'gp', label: 'GP', formula: 'profit / sales', format: 'percent' },
    { key: 'soh', label: 'Stock on hand', agg: 'sum', column: 'qty', snapshot: true },
    { key: 'ordered', label: 'Ordered', agg: 'sum', column: 'amount', stream: 'orders' },
  ],
  periods: {
    fiscal_year_start_month: 7,
    week_start: 'monday',
    custom: [{ key: 'opening_week', label: 'Opening week', from: '2026-03-02', to: '2026-03-08' }],
  },
};

export function fixtureModel(): ReportingModel {
  const checked = validateModel(MODEL_JSON);
  if (!checked.ok) throw new Error(`fixture model is invalid: ${JSON.stringify(checked.problems)}`);
  return checked.model;
}

/** The reason a call refuses with, or 'did not refuse'. */
export function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ReportingError) return err.reason;
    throw err;
  }
  return 'did not refuse';
}

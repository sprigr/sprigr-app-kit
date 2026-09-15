/**
 * mock-warehouse - the stock fixture.
 *
 * Fixed rows, not random ones: a shakedown asserts exact numbers, and a mock
 * that drifts between calls makes every downstream failure ambiguous.
 */

export interface StockFixtureRow {
  warehouse_key: string;
  sku: string;
  on_hand: number;
  reserved: number;
  held: number;
}

export const STOCK_FIXTURE: readonly StockFixtureRow[] = [
  { warehouse_key: 'mw_bne', sku: 'CONF-SKU-1', on_hand: 120, reserved: 4, held: 0 },
  { warehouse_key: 'mw_bne', sku: 'CONF-SKU-2', on_hand: 8, reserved: 0, held: 2 },
  { warehouse_key: 'mw_syd', sku: 'CONF-SKU-1', on_hand: 40, reserved: 1, held: 0 },
  { warehouse_key: 'mw_syd', sku: 'CONF-SKU-3', on_hand: 0, reserved: 0, held: 0 },
];

export const WAREHOUSE_FIXTURE = [
  { warehouse_key: 'mw_bne', name: 'Mock Brisbane', country: 'AU', cutoff_local_time: '14:00', active: true },
  { warehouse_key: 'mw_syd', name: 'Mock Sydney', country: 'AU', cutoff_local_time: '15:30', active: true },
] as const;

import { describe, expect, it } from 'vitest';
import { appendInBatches, datasetRows } from '../src/index';
import { checkAppend, fakeDatasets, isIsoDate, validateDatasetRows, type ManifestWithDatasets } from '../src/testing';

const MANIFEST: ManifestWithDatasets = {
  datasets: {
    daily: {
      mode: 'keyed',
      key: ['row_key'],
      version_field: 'imported_at',
      partition_key: ['date'],
      fields: {
        row_key: { type: 'string' },
        date: { type: 'date' },
        clicks: { type: 'number' },
        brand: { type: 'boolean' },
        imported_at: { type: 'number' },
      },
    },
    events: {
      partition_key: ['day'],
      fields: { day: { type: 'date' }, name: { type: 'string' } },
    },
  },
};
const DAILY = MANIFEST.datasets!.daily!;

describe('validateDatasetRows', () => {
  it('accepts a well-formed keyed row, nulls included', () => {
    expect(validateDatasetRows(DAILY, [{ row_key: 'a', date: '2026-10-01', clicks: 1, brand: null, imported_at: 5 }])).toEqual([]);
  });

  it('reports every code the append route uses', () => {
    const errors = validateDatasetRows(DAILY, [
      { objectID: 'x', row_key: 'a', date: '2026-10-01' },
      { row_key: 'b', date: '2026-10-01', clicks: '3', brand: 'yes' },
      { row_key: 'c', date: '01/10/2026' },
      { row_key: ' ', date: '2026-10-01' },
      { row_key: 'e' },
      { row_key: 'f', date: '2026-10-01', install_id: 'i' },
      { row_key: 'g', date: '2026-10-01', clicks: Number.NaN },
    ]);
    expect(errors).toEqual([
      { row: 0, code: 'unknown_field', field: 'objectID' },
      { row: 1, code: 'type_mismatch', field: 'clicks' },
      { row: 1, code: 'type_mismatch', field: 'brand' },
      { row: 2, code: 'bad_date', field: 'date' },
      { row: 3, code: 'missing_key', field: 'row_key' },
      { row: 4, code: 'missing_partition', field: 'date' },
      { row: 5, code: 'reserved_field', field: 'install_id' },
      { row: 6, code: 'type_mismatch', field: 'clicks' },
    ]);
  });

  it('takes the tombstone on a keyed dataset only, and only as a boolean', () => {
    expect(validateDatasetRows(DAILY, [{ row_key: 'a', date: '2026-10-01', _deleted: true }])).toEqual([]);
    expect(validateDatasetRows(DAILY, [{ row_key: 'a', date: '2026-10-01', _deleted: 1 }])).toEqual([{ row: 0, code: 'type_mismatch', field: '_deleted' }]);
    expect(validateDatasetRows(MANIFEST.datasets!.events!, [{ day: '2026-10-01', _deleted: true }])).toEqual([{ row: 0, code: 'reserved_field', field: '_deleted' }]);
  });

  it('does not check a key on an append dataset', () => {
    expect(validateDatasetRows(MANIFEST.datasets!.events!, [{ day: '2026-10-01' }])).toEqual([]);
  });

  it('caps the report at 50 errors', () => {
    const rows = Array.from({ length: 60 }, () => ({ nope: 1 }));
    expect(validateDatasetRows(MANIFEST.datasets!.events!, rows)).toHaveLength(50);
  });
});

describe('isIsoDate', () => {
  it('takes dates and datetimes that parse', () => {
    expect(isIsoDate('2026-10-01')).toBe(true);
    expect(isIsoDate('2026-10-01T12:00:00Z')).toBe(true);
    expect(isIsoDate('2026-10-01T12:00:00.123+10:00')).toBe(true);
    expect(isIsoDate('2026-13-45')).toBe(false);
    expect(isIsoDate('20261001')).toBe(false);
    expect(isIsoDate(20261001)).toBe(false);
  });
});

describe('checkAppend', () => {
  it('refuses an undeclared dataset and a bad row count', () => {
    expect(() => checkAppend(MANIFEST, 'nope', [{}])).toThrow('dataset_undeclared: nope');
    expect(() => checkAppend(MANIFEST, 'daily', [])).toThrow('bad row count 0');
    expect(() => checkAppend(MANIFEST, 'daily', Array.from({ length: 1_001 }, (_, i) => ({ row_key: `${i}`, date: '2026-10-01' })))).toThrow('bad row count 1001');
  });

  it('names the first problem, its value, and how many more', () => {
    expect(() => checkAppend(MANIFEST, 'daily', [{ row_key: 'a', date: '2026-10-01', clicks: '3' }, { row_key: 'b', date: '2026-10-01', objectID: 'b' }])).toThrow(
      'type_mismatch daily.clicks="3" (row 0) (+1 more)',
    );
    expect(() => checkAppend(MANIFEST, 'daily', [{ objectID: 'a', row_key: 'a', date: '2026-10-01' }])).toThrow('unknown_field daily.objectID (row 0)');
  });

  it('passes rows built by datasetRows from index docs', () => {
    const rows = datasetRows([{ objectID: 'a', date: '2026-10-01', clicks: 2 }], 1_700_000_000_000);
    expect(() => checkAppend(MANIFEST, 'daily', rows)).not.toThrow();
  });

  it('catches a doc whose objectID was never turned into row_key', () => {
    expect(() => checkAppend(MANIFEST, 'daily', [{ objectID: 'a', date: '2026-10-01' }])).toThrow(/unknown_field daily\.objectID/);
  });
});

describe('fakeDatasets', () => {
  it('records accepted appends and throws on refused ones', async () => {
    const datasets = fakeDatasets(MANIFEST);
    const rows = datasetRows(Array.from({ length: 1_500 }, (_, i) => ({ objectID: `k${i}`, date: '2026-10-01' })), 1);
    await expect(appendInBatches(datasets, 'daily', rows)).resolves.toBe(1_500);
    expect(datasets.appended.map((a) => a.rows.length)).toEqual([1_000, 500]);
    await expect(datasets.append('daily', [{ row_key: 'x' }])).rejects.toThrow(/missing_partition daily\.date/);
    expect(datasets.appended).toHaveLength(2);
  });
});

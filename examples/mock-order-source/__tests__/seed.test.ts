/**
 * The seed lives twice: in migration 0001 (per-install D1) and in
 * src/lib/records.ts (the in-memory store the tests and the conformance
 * harness run against). If they drift, every test here keeps passing while
 * the installed app answers differently, which is the worst shape a fixture
 * can fail in. This holds them together.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_LINES, SEED_LOCATIONS, SEED_ORDER, SEED_REQUEST } from '../src/lib/records';
import { memoryStore } from '../src/lib/store';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');

describe('the seed', () => {
  it('is written by migration 0001 with the same ids and money as the in-memory store', () => {
    expect(migration).toContain(`'${SEED_ORDER.source_ref}'`);
    expect(migration).toContain(`'${SEED_ORDER.source_number}'`);
    expect(migration).toContain(`, ${SEED_ORDER.total_minor},`);
    expect(migration).toContain(`'${SEED_REQUEST.source_request_ref}'`);
    for (const line of SEED_LINES) {
      expect(migration).toContain(`'${line.source_line_ref}'`);
      expect(migration).toContain(`'${line.sku}'`);
    }
    for (const location of SEED_LOCATIONS) {
      expect(migration).toContain(`'${location.source_location_ref}'`);
      expect(migration).toContain(`'${location.name}'`);
    }
  });

  it('is present in a fresh in-memory store', async () => {
    const store = memoryStore();
    expect(await store.getOrder(SEED_ORDER.source_ref)).toMatchObject({ source_number: 'MOS-1001' });
    expect(await store.listLines(SEED_ORDER.source_ref)).toHaveLength(2);
    expect(await store.getRequest(SEED_REQUEST.source_request_ref)).toMatchObject({ state: 'submitted' });
    expect(await store.listLocations()).toHaveLength(2);
  });

  it('gives each store instance its own copy, so one test cannot bleed into the next', async () => {
    const a = memoryStore();
    const b = memoryStore();
    await a.putOrder({ ...SEED_ORDER, status: 'cancelled' });
    expect((await b.getOrder(SEED_ORDER.source_ref))?.status).toBe('received');
  });
});

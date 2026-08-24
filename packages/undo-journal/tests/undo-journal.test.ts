import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createUndoJournal, undoJournalSchemaSql, DEFAULT_TTL_MS } from '../src/undo-journal';
import { makeMockD1, type JournalRecord } from './mock-d1';

const TABLE = 'xero_undo_journal';

function journal(overrides: Partial<Parameters<typeof createUndoJournal>[0]> = {}, initial: JournalRecord[] = []) {
  const { db, state } = makeMockD1(initial);
  return {
    j: createUndoJournal({ db, table: TABLE, scope: 'xero-undo', ...overrides }),
    state,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('captureBefore', () => {
  it('stores the before-image and returns a ref', async () => {
    const { j, state } = journal();
    const got = await j.captureBefore({
      entity: 'credit_note',
      originalId: 'cn-1',
      before: { Total: 77 },
      connection: 'tenant-au',
    });
    expect(got?.ref).toMatch(/^cap_[0-9a-f]{24}$/);
    expect(got).toMatchObject({ entity: 'credit_note', originalId: 'cn-1' });
    const row = state.rows.get(got!.ref)!;
    expect(row.connection).toBe('tenant-au');
    expect(JSON.parse(row.before_json)).toEqual({ Total: 77 });
    expect(row.expires_at - row.created_at).toBe(DEFAULT_TTL_MS);
  });

  it('pins the connection verbatim, including when it is null', async () => {
    const { j, state } = journal();
    const got = await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: null });
    expect(state.rows.get(got!.ref)!.connection).toBeNull();
  });

  it('refuses an oversize before-image rather than TRUNCATING it', async () => {
    // The whole point: a partial capture replays as a silently incomplete
    // object. Storing nothing and offering nothing is the honest outcome.
    const { j, state } = journal({ maxBeforeJson: 100 });
    const got = await j.captureBefore({
      entity: 'contact',
      originalId: 'c-1',
      before: { blob: 'x'.repeat(500) },
      connection: null,
    });
    expect(got).toBeNull();
    expect(state.rows.size).toBe(0);
    // The warning must name the field and BOTH lengths so the cap can be
    // revisited with evidence rather than guesswork.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/is 51\d chars, over the 100 cap/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/NOT truncating/);
  });

  it.each([
    ['null before', null],
    ['empty object', {}],
    ['undefined', undefined],
  ])('returns null for an empty before-image (%s)', async (_label, before) => {
    const { j, state } = journal();
    expect(await j.captureBefore({ entity: 'e', originalId: 'i', before, connection: null })).toBeNull();
    expect(state.rows.size).toBe(0);
  });

  it('returns null on an unserialisable before-image instead of throwing', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { j } = journal();
    expect(await j.captureBefore({ entity: 'e', originalId: 'i', before: cyclic, connection: null })).toBeNull();
  });

  it('returns null when the insert fails, and does NOT throw', async () => {
    // The caller does the write regardless. A write that fails because its
    // safety net failed is worse than a write with no safety net.
    const { j, state } = journal();
    state.failOn.push('INSERT INTO');
    expect(await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: 'c' })).toBeNull();
  });

  it('a failing TTL sweep never fails the capture', async () => {
    const { j, state } = journal();
    state.failOn.push('WHERE expires_at <');
    const got = await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: 'c' });
    expect(got).not.toBeNull();
  });

  it('sweeps expired rows opportunistically', async () => {
    const stale: JournalRecord = {
      ref: 'cap_old',
      entity: 'e',
      original_id: 'old',
      connection: null,
      before_json: '{"a":1}',
      created_at: 0,
      expires_at: 1,
    };
    const { j, state } = journal({}, [stale]);
    await j.captureBefore({ entity: 'e', originalId: 'new', before: { a: 1 }, connection: null });
    expect(state.rows.has('cap_old')).toBe(false);
    expect(state.rows.size).toBe(1);
  });

  it('mints a distinct ref per capture', async () => {
    const { j } = journal();
    const refs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = await j.captureBefore({ entity: 'e', originalId: `i${i}`, before: { i }, connection: null });
      refs.add(r!.ref);
    }
    expect(refs.size).toBe(50);
  });
});

describe('loadBefore', () => {
  it('round-trips the captured object and the connection pin', async () => {
    const { j } = journal();
    const cap = await j.captureBefore({
      entity: 'credit_note',
      originalId: 'cn-1',
      before: { Total: 77, Lines: [{ Description: 'Fee' }] },
      connection: 'tenant-us',
    });
    const row = await j.loadBefore<{ Total: number }>(cap!.ref);
    expect(row).toMatchObject({ entity: 'credit_note', original_id: 'cn-1', connection: 'tenant-us' });
    expect(row!.before).toEqual({ Total: 77, Lines: [{ Description: 'Fee' }] });
  });

  it('returns null for an unknown ref rather than throwing', async () => {
    // An agent confabulating a plausible handle is a thing that has actually
    // happened, so this path must fail closed and quietly.
    const { j } = journal();
    expect(await j.loadBefore('cap_deadbeefdeadbeefdeadbeef')).toBeNull();
  });

  it('returns null when the stored JSON cannot be parsed', async () => {
    const { j } = journal({}, [
      {
        ref: 'cap_bad',
        entity: 'e',
        original_id: 'i',
        connection: null,
        before_json: '{not json',
        created_at: 0,
        expires_at: Date.now() + 1e9,
      },
    ]);
    expect(await j.loadBefore('cap_bad')).toBeNull();
  });

  it('returns null when the read itself fails', async () => {
    const { j, state } = journal();
    state.failOn.push('SELECT entity');
    expect(await j.loadBefore('cap_x')).toBeNull();
  });
});

describe('dropBefore', () => {
  it('removes the row', async () => {
    const { j, state } = journal();
    const cap = await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: null });
    await j.dropBefore(cap!.ref);
    expect(state.rows.size).toBe(0);
  });

  it('never throws when the delete fails', async () => {
    const { j, state } = journal();
    const cap = await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: null });
    state.failOn.push('WHERE ref =');
    await expect(j.dropBefore(cap!.ref)).resolves.toBeUndefined();
  });
});

describe('table name is validated, not trusted', () => {
  // It is the one string in the package that reaches SQL uninterpolated.
  it.each([
    'bad name',
    'x; DROP TABLE y',
    "x'--",
    '1_leading_digit',
    '',
  ])('rejects %j', (table) => {
    const { db } = makeMockD1();
    expect(() => createUndoJournal({ db, table, scope: 's' })).toThrow(/bare SQL identifier/);
    expect(() => undoJournalSchemaSql(table)).toThrow(/bare SQL identifier/);
  });

  it('accepts a normal table name', () => {
    const { db } = makeMockD1();
    expect(() => createUndoJournal({ db, table: 'xero_undo_journal', scope: 's' })).not.toThrow();
  });
});

describe('undoJournalSchemaSql', () => {
  it('emits a table and index for the given name', () => {
    const sql = undoJournalSchemaSql('acme_undo_journal');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS acme_undo_journal');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_acme_undo_journal_expires');
  });

  it('declares every column the runtime reads and writes', () => {
    // A schema that drifts from the queries fails at runtime on a real delete,
    // which is the worst possible moment to find out.
    const sql = undoJournalSchemaSql(TABLE);
    for (const col of ['ref', 'entity', 'original_id', 'connection', 'before_json', 'created_at', 'expires_at']) {
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('the emitted schema satisfies the statements the journal actually runs', async () => {
    const { j, state } = journal();
    const cap = await j.captureBefore({ entity: 'e', originalId: 'i', before: { a: 1 }, connection: 'c' });
    await j.loadBefore(cap!.ref);
    await j.dropBefore(cap!.ref);
    const columnsIn = (sql: string): string[] =>
      [...sql.matchAll(/\b(ref|entity|original_id|connection|before_json|created_at|expires_at)\b/g)].map(
        (m) => m[1] as string,
      );
    const schema = undoJournalSchemaSql(TABLE);
    for (const sql of state.sql) {
      for (const col of columnsIn(sql)) {
        expect(schema, `column '${col}' used in SQL but absent from the schema`).toMatch(
          new RegExp(`\\b${col}\\b`),
        );
      }
    }
  });
});

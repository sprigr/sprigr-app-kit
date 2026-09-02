import { describe, expect, it, vi } from 'vitest';
import { runUndoApply, type UndoApplyOptions } from '../../src/write-protection/undo-apply';

interface Env { current: string; pinned?: string }

function make(over: Partial<UndoApplyOptions<Env>> = {}, row: unknown = { entity: 'delete_collection', original_id: 'C1', connection: 'eu', before: { title: 'Summer' } }) {
  const journal = { loadBefore: vi.fn(async () => row as never), dropBefore: vi.fn(async () => {}) };
  const restore = vi.fn(async () => ({ ok: true, newId: 'C2' }));
  const o: UndoApplyOptions<Env> = {
    env: { current: 'us' },
    journal,
    specs: { delete_collection: { resource: 'collection', fidelity: 'recreated', restore, notRestored: 'image alt text' } },
    pin: (env, connection) => ({ ...env, pinned: connection ?? undefined }),
    ...over,
  };
  return { o, journal, restore };
}

describe('runUndoApply', () => {
  it('refuses without a ref', async () => {
    const { o } = make();
    expect(await runUndoApply({}, o)).toMatchObject({ ok: false, error: 'missing_ref' });
  });

  it('reports a missing before-image plainly', async () => {
    const { o } = make({}, null);
    expect(await runUndoApply({ ref: 'cap_1' }, o)).toMatchObject({ ok: false, error: 'before_image_missing' });
  });

  it('fails loudly when the capturing tool is no longer in the registry', async () => {
    const { o } = make({ specs: {} });
    expect(await runUndoApply({ ref: 'cap_1' }, o)).toMatchObject({ ok: false, error: 'undo_no_longer_supported' });
  });

  it('re-pins to the JOURNALLED connection, restores, then drops the copy', async () => {
    const { o, journal, restore } = make();
    const r = await runUndoApply({ ref: 'cap_1' }, o);
    expect(restore).toHaveBeenCalledWith({ current: 'us', pinned: 'eu' }, { title: 'Summer' }, expect.objectContaining({ connection: 'eu' }));
    expect(journal.dropBefore).toHaveBeenCalledWith('cap_1');
    expect(r).toMatchObject({ ok: true, fidelity: 'recreated', new_id: 'C2', connection: 'eu', not_restored: 'image alt text' });
    expect((r as { note: string }).note).toMatch(/replacement, not as an undo/);
  });

  it('a pin that returns null is a connection mismatch and nothing is restored', async () => {
    const { o, restore } = make({ pin: () => null });
    expect(await runUndoApply({ ref: 'cap_1' }, o)).toMatchObject({ ok: false, error: 'connection_mismatch' });
    expect(restore).not.toHaveBeenCalled();
  });

  it('a pin that throws is connection_unavailable', async () => {
    const { o } = make({ pin: async () => { throw new Error('token expired'); } });
    expect(await runUndoApply({ ref: 'cap_1' }, o)).toMatchObject({ ok: false, error: 'connection_unavailable' });
  });

  it('a refused restore keeps the before-image', async () => {
    const { o, journal } = make({ specs: { delete_collection: { resource: 'collection', fidelity: 'full', restore: async () => ({ ok: false, error: '422' }) } } });
    expect(await runUndoApply({ ref: 'cap_1' }, o)).toMatchObject({ ok: false, error: 'restore_failed' });
    expect(journal.dropBefore).not.toHaveBeenCalled();
  });

  it('a full-fidelity restore reads as a restore, not a replacement', async () => {
    const { o } = make({ specs: { delete_collection: { resource: 'contact', fidelity: 'full', restore: async () => ({ ok: true }) } } });
    const r = await runUndoApply({ ref: 'cap_1' }, o);
    expect(r).toMatchObject({ ok: true, fidelity: 'full', new_id: null });
    expect((r as { note: string }).note).toMatch(/^Restored contact C1/);
  });
});

describe('runUndoApply with a pinned type distinct from the env', () => {
  it('hands restore whatever pin returned, and maps a throwing restore to restore_failed', async () => {
    type State = { tenantId: string; token: string };
    const journal = {
      loadBefore: vi.fn(async () => ({ entity: 'update_contact', original_id: 'c1', connection: 'org-B', before: { Name: 'A' } }) as never),
      dropBefore: vi.fn(async () => {}),
    };
    const restore = vi.fn(async (state: State) => { if (state.tenantId !== 'org-B') throw new Error('wrong org'); });
    const opts = {
      env: { DB: {} },
      journal,
      specs: { update_contact: { resource: 'contact', fidelity: 'full' as const, restore } },
      pin: async (_env: { DB: unknown }, connection: string | null): Promise<State | null> => (connection ? { tenantId: connection, token: 't' } : null),
    };
    const ok = await runUndoApply({ ref: 'cap_1' }, opts);
    expect(restore).toHaveBeenCalledWith({ tenantId: 'org-B', token: 't' }, { Name: 'A' }, expect.objectContaining({ connection: 'org-B' }));
    expect(ok).toMatchObject({ ok: true, fidelity: 'full', connection: 'org-B' });

    const throwing = { ...opts, specs: { update_contact: { resource: 'contact', fidelity: 'full' as const, restore: async () => { throw new Error('422 Validation'); } } } };
    journal.dropBefore.mockClear();
    const failed = await runUndoApply({ ref: 'cap_1' }, throwing);
    expect(failed).toMatchObject({ ok: false, error: 'restore_failed' });
    expect((failed as { note: string }).note).toMatch(/422 Validation/);
    expect(journal.dropBefore).not.toHaveBeenCalled();
  });
});

describe('restore may disclose per-run detail', () => {
  it('spreads extra into the success payload and lets the result override notRestored', async () => {
    const journal = {
      loadBefore: vi.fn(async () => ({ entity: 'delete_line', original_id: '336', connection: '42', before: { record: {} } }) as never),
      dropBefore: vi.fn(async () => {}),
    };
    const r = await runUndoApply({ ref: 'cap_1' }, {
      env: {},
      journal,
      specs: { delete_line: { resource: 'labour line', fidelity: 'recreated', notRestored: 'static', restore: async () => ({ ok: true, newId: '991', notRestored: 'child rows', extra: { fields_not_restored: ['ID', 'Total'], children_captured: { labor: [] } } }) } },
      pin: (e) => e,
    });
    expect(r).toMatchObject({ ok: true, new_id: '991', not_restored: 'child rows', fields_not_restored: ['ID', 'Total'], children_captured: { labor: [] } });
    expect((r as { note: string }).note).toMatch(/Not restored: child rows\./);
  });
});

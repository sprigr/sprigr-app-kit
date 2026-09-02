import { describe, expect, it, vi } from 'vitest';
import { offerUndo, safeCapture } from '../../src/write-protection/undo-capture';

describe('safeCapture', () => {
  it('returns the object, or null with a warning when the read throws or is not an object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await safeCapture('s', 'update_contact', '1', async () => ({ Name: 'A' }))).toEqual({ Name: 'A' });
    expect(await safeCapture('s', 'update_contact', '1', async () => null)).toBeNull();
    expect(await safeCapture('s', 'update_contact', '1', async () => { throw new Error('403'); })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[s\] update_contact 1: capture failed/));
    warn.mockRestore();
  });
});

describe('offerUndo', () => {
  const base = {
    entity: 'update_contact',
    id: 'c1',
    fidelity: 'full' as const,
    resource: 'contact',
    describe: (b: Record<string, unknown>) => `contact ${b.Name}`,
    warning: 'Overwrites later changes.',
  };

  it('stores the copy and builds the envelope, naming the connection with the chosen preposition', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_1' })) };
    const env = await offerUndo({ ...base, journal, before: { Name: 'Acme' }, connection: 'BoardCave AU', connectionPreposition: 'in' });
    expect(journal.captureBefore).toHaveBeenCalledWith({ entity: 'update_contact', originalId: 'c1', before: { Name: 'Acme' }, connection: 'BoardCave AU' });
    expect(env).toEqual({ fidelity: 'full', warning: 'Overwrites later changes.', describes: 'contact Acme in BoardCave AU', resource: 'contact', ref: 'cap_1' });
  });

  it('labels the connection for people while journalling the pin', async () => {
    const journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_2' })) };
    const env = await offerUndo({ ...base, journal, before: { Name: 'Acme' }, connection: 'tenant-uuid', connectionLabel: 'BoardCave AU', connectionPreposition: 'in' });
    expect(journal.captureBefore).toHaveBeenCalledWith(expect.objectContaining({ connection: 'tenant-uuid' }));
    expect(env?.describes).toBe('contact Acme in BoardCave AU');
  });

  it('offers nothing on a null capture or a journal that could not store', async () => {
    const journal = { captureBefore: vi.fn(async () => null) };
    expect(await offerUndo({ ...base, journal, before: null, connection: null })).toBeUndefined();
    expect(journal.captureBefore).not.toHaveBeenCalled();
    expect(await offerUndo({ ...base, journal, before: { Name: 'A' }, connection: null })).toBeUndefined();
  });
});

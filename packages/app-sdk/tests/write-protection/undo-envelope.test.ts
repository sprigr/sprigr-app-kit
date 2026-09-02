import { describe, expect, it } from 'vitest';
import { InvalidUndoEnvelopeError, fullWarning, recreatedWarning, undoEnvelope } from '../../src/write-protection/undo-envelope';

const good = { fidelity: 'recreated' as const, warning: 'w', describes: 'd', resource: 'r', ref: 'cap_1' };

describe('undoEnvelope', () => {
  it('returns a trimmed envelope for valid input', () => {
    expect(undoEnvelope({ ...good, warning: '  w  ' })).toEqual({ ...good, warning: 'w' });
  });

  it.each(['warning', 'describes', 'resource', 'ref'] as const)('refuses a blank %s, which the platform would silently drop', (key) => {
    expect(() => undoEnvelope({ ...good, [key]: '' })).toThrow(InvalidUndoEnvelopeError);
    expect(() => undoEnvelope({ ...good, [key]: '   ' })).toThrow(/mints no token/);
  });

  it('refuses an unknown fidelity', () => {
    expect(() => undoEnvelope({ ...good, fidelity: 'partial' as never })).toThrow(/fidelity/);
  });

  it('warnings are never empty and a recreate always says the id changes', () => {
    expect(recreatedWarning('collection')).toMatch(/new id/i);
    expect(recreatedWarning('collection', 'metafields')).toMatch(/Not restored: metafields\./);
    expect(fullWarning()).toMatch(/overwritten/);
    expect(fullWarning('attachments')).toMatch(/does not restore attachments\./);
  });
});

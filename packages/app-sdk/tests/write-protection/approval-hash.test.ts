import { describe, expect, it } from 'vitest';
import { UNIT_SEP, approvalHash, seq, set } from '../../src/write-protection/approval-hash';

describe('approvalHash', () => {
  it('uses a control-character separator so parts cannot be re-partitioned', () => {
    expect(UNIT_SEP).toBe('\u001f');
    expect(approvalHash('a', 'bc')).not.toBe(approvalHash('ab', 'c'));
  });

  it('treats null and undefined as empty parts, keeping positions stable', () => {
    expect(approvalHash('id', undefined, 'x')).toBe(approvalHash('id', null, 'x'));
    expect(approvalHash('id', undefined, 'x')).toBe(`id${UNIT_SEP}${UNIT_SEP}x`);
  });

  it('set() is order-insensitive and seq() is not', () => {
    expect(set(['red', 'green', 'blue'])).toBe(set(['blue', 'red', 'green']));
    expect(seq(['red', 'green'])).not.toBe(seq(['green', 'red']));
    expect(set('not an array')).toBe('');
    expect(seq(undefined)).toBe('');
  });
});

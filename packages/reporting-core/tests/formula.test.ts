import { describe, it, expect } from 'vitest';
import { emitFormulaSql, formulaRefs, parseFormula } from '../src';
import { reasonOf } from './fixture';

const sql = (formula: string, extra: { days?: number; periodCount?: number } = {}): string =>
  emitFormulaSql(parseFormula(formula), { measure: (key) => key.toUpperCase(), ...extra });

describe('parseFormula and emitFormulaSql', () => {
  it('binds multiplication tighter than addition', () => {
    expect(sql('1 + 2 * 3')).toBe('(1 + (2 * 3))');
    expect(sql('(1 + 2) * 3')).toBe('((1 + 2) * 3)');
  });

  it('applies unary minus after a power, and powers right to left', () => {
    expect(sql('-2^2')).toBe('(-power(2, 2))');
    expect(sql('2^3^2')).toBe('power(2, power(3, 2))');
  });

  it('guards every division, so a zero divisor is NULL and not an error', () => {
    expect(sql('(sales - cost) / sales')).toBe('(((SALES) - (COST)) / NULLIF((SALES), 0))');
  });

  it('reads a percent literal and a condition inside IF', () => {
    expect(sql('IF(gp < 5%, 1, 0)')).toBe('(CASE WHEN ((GP) < 0.05) THEN 1 ELSE 0 END)');
  });

  it('skips blanks in SUM and AVERAGE', () => {
    expect(sql('SUM(a, b)')).toBe('(COALESCE((A), 0) + COALESCE((B), 0))');
    expect(sql('AVERAGE(a, b)')).toContain('NULLIF((CASE WHEN (A) IS NULL THEN 0 ELSE 1 END) + (CASE WHEN (B) IS NULL THEN 0 ELSE 1 END), 0)');
  });

  it('fills DAYS and PERIODCOUNT from the period, and refuses them without one', () => {
    expect(sql('sales / DAYS()', { days: 30 })).toBe('((SALES) / NULLIF(30, 0))');
    expect(sql('sales / PERIODCOUNT()', { periodCount: 12 })).toBe('((SALES) / NULLIF(12, 0))');
    expect(reasonOf(() => sql('sales / DAYS()'))).toBe('formula_function_unsupported');
  });

  it('takes function names in any case', () => {
    expect(sql('abs(sales)')).toBe('abs((SALES))');
  });

  it('lists each measure a formula names once', () => {
    expect(formulaRefs(parseFormula('a + b * a - MAX(c, b)'))).toEqual(['a', 'b', 'c']);
  });

  it('keeps a grid function when parsing and refuses it when emitting', () => {
    expect(reasonOf(() => parseFormula('RANK(sales)'))).toBe('did not refuse');
    expect(reasonOf(() => sql('RANK(sales)'))).toBe('formula_function_unsupported');
  });

  it.each([
    ['', 'formula_empty'],
    ['1 +', 'formula_syntax'],
    ['sales; DROP TABLE x', 'formula_syntax'],
    ["sales + 'x'", 'formula_syntax'],
    ['(sales', 'formula_syntax'],
    ['NOPE(1)', 'formula_unknown_function'],
    ['ABS()', 'formula_arity'],
    ['IF(sales, 1, 0)', 'formula_type'],
    ['sales > 1', 'formula_type'],
    ['AND(sales, cost)', 'formula_type'],
    ['ROUND(sales, 2.5)', 'formula_type'],
    ['x'.repeat(2001), 'formula_too_long'],
  ])('refuses %j with %s', (formula, reason) => {
    expect(reasonOf(() => parseFormula(formula))).toBe(reason);
  });
});

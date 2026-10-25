import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import { evaluateFormula, formulaParameters, parseFormula } from './formula.js';

const calc = (text: string, values: Record<string, string> = {}) => evaluateFormula(text, values);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('formula evaluator (spec P1-07 T-1)', () => {
  it('evaluates numbers, parameters and operator precedence', () => {
    expect(calc('2 + 3 * 4')).toBe('14');
    expect(calc('(2 + 3) * 4')).toBe('20');
    expect(calc('10 - 4 - 3')).toBe('3');
    expect(calc('100 / 5 / 2')).toBe('10');
    expect(calc('-3 + 5')).toBe('2');
    expect(calc('- -3')).toBe('3');
    expect(calc('length * height', { length: '12.5', height: '8' })).toBe('100');
    expect(calc('  length*2 ', { length: '4' })).toBe('8');
  });

  it('keeps decimal precision where binary floats fail', () => {
    expect(calc('0.1 + 0.2')).toBe('0.3');
    expect(calc('1.1 * 1.1')).toBe('1.21');
    expect(calc('1 / 3')).toBe('0.3333333333333333333333333333333333333333');
  });

  it('supports ceil, floor, round, max and min', () => {
    expect(calc('ceil(2.1)')).toBe('3');
    expect(calc('floor(2.9)')).toBe('2');
    expect(calc('round(2.5)')).toBe('3');
    expect(calc('round(2.4)')).toBe('2');
    expect(calc('round(1.23456, 2)')).toBe('1.23');
    expect(calc('round(1.235, 2)')).toBe('1.24');
    expect(calc('max(1, 7, 3)')).toBe('7');
    expect(calc('min(4, 2, 9)')).toBe('2');
    expect(calc('ceil(a / b)', { a: '10', b: '4' })).toBe('3');
  });

  it('rejects round() with bad decimal places', () => {
    expect(codeOf(() => calc('round(1.5, 1.5)'))).toBe('formula_round_places');
    expect(codeOf(() => calc('round(1.5, 5)'))).toBe('formula_round_places');
    expect(codeOf(() => calc('round(1.5, -1)'))).toBe('formula_round_places');
  });

  it('rejects unknown identifiers and functions', () => {
    expect(codeOf(() => calc('width * 2'))).toBe('formula_unknown_identifier');
    expect(codeOf(() => calc('sqrt(4)'))).toBe('formula_unknown_function');
  });

  it('rejects division by zero, also from a parameter', () => {
    expect(codeOf(() => calc('1 / 0'))).toBe('formula_division_by_zero');
    expect(codeOf(() => calc('5 / (a - a)', { a: '3' }))).toBe('formula_division_by_zero');
  });

  it('rejects syntax errors, wrong arity and runaway input', () => {
    expect(codeOf(() => calc(''))).toBe('formula_empty');
    expect(codeOf(() => calc('   '))).toBe('formula_empty');
    expect(codeOf(() => calc('2 +'))).toBe('formula_syntax');
    expect(codeOf(() => calc('(2 + 3'))).toBe('formula_syntax');
    expect(codeOf(() => calc('2 3'))).toBe('formula_syntax');
    expect(codeOf(() => calc('* 3'))).toBe('formula_syntax');
    expect(codeOf(() => calc('ceil(1, 2)'))).toBe('formula_arity');
    expect(codeOf(() => calc('max(1)'))).toBe('formula_arity');
    expect(codeOf(() => calc('ceil(1'))).toBe('formula_syntax');
    expect(codeOf(() => calc('1 + '.repeat(200) + '1'))).toBe('formula_too_long');
    expect(codeOf(() => calc('('.repeat(40) + '1' + ')'.repeat(40)))).toBe('formula_too_deep');
  });

  it('rejects injection attempts and code-like text', () => {
    const attempts = [
      'process.exit(1)',
      'constructor',
      'constructor.constructor("return 1")()',
      '__proto__',
      'this',
      'globalThis',
      '"abc"',
      "'a' + 'b'",
      '1; 2',
      '`1`',
      '${1}',
      'a[0]',
      '{}',
      '1 == 1',
      '2 ** 3',
      'require("fs")',
      'eval("1")',
      'Function("return 1")()',
      '1e3',
    ];
    for (const attempt of attempts) {
      expect(() => calc(attempt, { a: '1' }), attempt).toThrow(ValidationError);
    }
  });

  it('does not resolve inherited object keys as parameters', () => {
    expect(codeOf(() => calc('toString'))).toBe('formula_unknown_identifier');
    expect(codeOf(() => calc('hasOwnProperty'))).toBe('formula_unknown_identifier');
  });

  it('lists the parameters a formula uses once each, in order', () => {
    const node = parseFormula('ceil(a * b) + max(b, -c) - (a / 2)');
    expect(formulaParameters(node)).toEqual(['a', 'b', 'c']);
    expect(formulaParameters(parseFormula('3'))).toEqual([]);
  });
});

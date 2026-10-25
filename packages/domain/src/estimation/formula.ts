/* eslint no-eval: "error", no-new-func: "error", no-implied-eval: "error" */
// BR-1 / AC-4: quantity formulas are parsed by a small recursive-descent parser and evaluated on
// Decimal. Nothing here builds code from text.
import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const formulaFunctions = ['ceil', 'floor', 'round', 'max', 'min'] as const;
type FormulaFunction = (typeof formulaFunctions)[number];

const MAX_LENGTH = 500;
const MAX_DEPTH = 32;

export type FormulaNode =
  | { type: 'number'; value: string }
  | { type: 'param'; name: string }
  | { type: 'negate'; operand: FormulaNode }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { type: 'call'; fn: FormulaFunction; args: FormulaNode[] };

type Token =
  | { kind: 'number' | 'name'; text: string }
  | { kind: 'symbol'; text: string }
  | { kind: 'end'; text: '' };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/(),]))/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (text.slice(position).trim() !== '') {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(text);
    if (match === null) {
      throw new ValidationError(
        'formula_invalid_character',
        'The formula has an unexpected character',
      );
    }
    position = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'number', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', text: match[2] });
    else tokens.push({ kind: 'symbol', text: match[3] as string });
  }
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

const syntaxError = () => new ValidationError('formula_syntax', 'The formula is not valid');

const isFunction = (name: string): name is FormulaFunction =>
  (formulaFunctions as readonly string[]).includes(name);

const ARITY: Record<FormulaFunction, [number, number]> = {
  ceil: [1, 1],
  floor: [1, 1],
  round: [1, 2],
  max: [2, 10],
  min: [2, 10],
};

/** Parses a formula into a tree. Throws `ValidationError` for anything outside the language. */
export function parseFormula(text: string): FormulaNode {
  if (text.trim() === '') throw new ValidationError('formula_empty', 'The formula is empty');
  if (text.length > MAX_LENGTH) {
    throw new ValidationError('formula_too_long', 'The formula is too long');
  }
  const tokens = tokenize(text);
  let index = 0;
  let depth = 0;

  const peek = (): Token => tokens[index] as Token;
  const take = (): Token => tokens[index++] as Token;
  const accept = (symbol: string): boolean => {
    const token = peek();
    if (token.kind === 'symbol' && token.text === symbol) {
      index++;
      return true;
    }
    return false;
  };
  const expect = (symbol: string): void => {
    if (!accept(symbol)) throw syntaxError();
  };

  function expression(): FormulaNode {
    if (++depth > MAX_DEPTH) {
      throw new ValidationError('formula_too_deep', 'The formula is nested too deeply');
    }
    let left = term();
    for (;;) {
      const op = accept('+') ? '+' : accept('-') ? '-' : null;
      if (op === null) break;
      left = { type: 'binary', op, left, right: term() };
    }
    depth--;
    return left;
  }

  function term(): FormulaNode {
    let left = unary();
    for (;;) {
      const op = accept('*') ? '*' : accept('/') ? '/' : null;
      if (op === null) break;
      left = { type: 'binary', op, left, right: unary() };
    }
    return left;
  }

  function unary(): FormulaNode {
    if (accept('-')) return { type: 'negate', operand: unary() };
    return primary();
  }

  function primary(): FormulaNode {
    const token = take();
    if (token.kind === 'number') return { type: 'number', value: token.text };
    if (token.kind === 'name') {
      if (!accept('(')) return { type: 'param', name: token.text };
      if (!isFunction(token.text)) {
        throw new ValidationError('formula_unknown_function', `Unknown function ${token.text}`);
      }
      const args = [expression()];
      while (accept(',')) args.push(expression());
      expect(')');
      const [min, max] = ARITY[token.text];
      if (args.length < min || args.length > max) {
        throw new ValidationError('formula_arity', `Wrong number of arguments for ${token.text}`);
      }
      return { type: 'call', fn: token.text, args };
    }
    if (token.kind === 'symbol' && token.text === '(') {
      const inner = expression();
      expect(')');
      return inner;
    }
    throw syntaxError();
  }

  const root = expression();
  if (peek().kind !== 'end') throw syntaxError();
  return root;
}

/** The parameter names a formula uses, in order of first appearance. */
export function formulaParameters(node: FormulaNode): string[] {
  const names = new Set<string>();
  const walk = (current: FormulaNode): void => {
    if (current.type === 'param') names.add(current.name);
    else if (current.type === 'negate') walk(current.operand);
    else if (current.type === 'binary') {
      walk(current.left);
      walk(current.right);
    } else if (current.type === 'call') current.args.forEach(walk);
  };
  walk(node);
  return [...names];
}

/** Evaluates a parsed formula. `values` maps parameter names to decimal text. */
export function evaluateNode(node: FormulaNode, values: ReadonlyMap<string, string>): Decimal {
  switch (node.type) {
    case 'number':
      return new Dec(node.value);
    case 'param': {
      const value = values.get(node.name);
      if (value === undefined) {
        throw new ValidationError('formula_unknown_identifier', `Unknown parameter ${node.name}`);
      }
      return new Dec(value);
    }
    case 'negate':
      return evaluateNode(node.operand, values).neg();
    case 'binary': {
      const left = evaluateNode(node.left, values);
      const right = evaluateNode(node.right, values);
      if (node.op === '+') return left.plus(right);
      if (node.op === '-') return left.minus(right);
      if (node.op === '*') return left.times(right);
      if (right.isZero()) {
        throw new ValidationError('formula_division_by_zero', 'The formula divides by zero');
      }
      return left.div(right);
    }
    case 'call': {
      const args = node.args.map((arg) => evaluateNode(arg, values));
      const first = args[0] as Decimal;
      if (node.fn === 'ceil') return first.ceil();
      if (node.fn === 'floor') return first.floor();
      if (node.fn === 'max') return Dec.max(...args);
      if (node.fn === 'min') return Dec.min(...args);
      const places = args[1] ?? new Dec(0);
      if (!places.isInteger() || places.isNegative() || places.greaterThan(4)) {
        throw new ValidationError('formula_round_places', 'round() takes 0 to 4 decimal places');
      }
      return first.toDecimalPlaces(places.toNumber(), Decimal.ROUND_HALF_UP);
    }
  }
}

/** Parses and evaluates in one step; the result is a plain decimal string. */
export function evaluateFormula(text: string, values: Readonly<Record<string, string>>): string {
  const map = new Map(Object.entries(values));
  return evaluateNode(parseFormula(text), map).toString();
}

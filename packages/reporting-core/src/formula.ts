/**
 * Formula measures and user calculations.
 *
 * One parser, a closed function list, and a typed AST. An identifier can only
 * name a measure; the emitter asks the caller for that measure's SQL, so no
 * text from a formula ever reaches the statement.
 */
import { ReportingError } from './reasons';
import { sqlNumber } from './sql';

export const FORMULA_FUNCTIONS = [
  'ABS', 'AND', 'AVERAGE', 'COALESCE', 'DAYS', 'FINITE', 'FORECAST.LINEAR', 'IF', 'MAX', 'MIN',
  'NOT', 'OR', 'PERCENTILE', 'PERIODCOUNT', 'POWER', 'RANK', 'ROUND', 'SQRT', 'SUM',
] as const;
export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number];

export type FormulaBinaryOp = '+' | '-' | '*' | '/' | '^' | '=' | '<>' | '<' | '<=' | '>' | '>=';

export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'ref'; key: string }
  | { t: 'neg'; x: FormulaNode }
  | { t: 'bin'; op: FormulaBinaryOp; l: FormulaNode; r: FormulaNode }
  | { t: 'call'; fn: FormulaFunction; args: FormulaNode[] };

export const FORMULA_MAX_CHARS = 2_000;
const MAX_DEPTH = 40;

type ValueType = 'num' | 'bool';
const COMPARISONS: readonly string[] = ['=', '<>', '<', '<=', '>', '>='];

/** Grid functions: they parse (so an imported calculation is kept) but have no SQL form yet. */
const GRID_ONLY: readonly FormulaFunction[] = ['RANK', 'PERCENTILE', 'FORECAST.LINEAR'];

interface Signature { min: number; max: number; args: ValueType; returns: ValueType }
const SIGNATURES: Record<FormulaFunction, Signature> = {
  ABS: { min: 1, max: 1, args: 'num', returns: 'num' },
  AND: { min: 1, max: 30, args: 'bool', returns: 'bool' },
  AVERAGE: { min: 1, max: 30, args: 'num', returns: 'num' },
  COALESCE: { min: 1, max: 30, args: 'num', returns: 'num' },
  DAYS: { min: 0, max: 0, args: 'num', returns: 'num' },
  FINITE: { min: 1, max: 2, args: 'num', returns: 'num' },
  'FORECAST.LINEAR': { min: 1, max: 3, args: 'num', returns: 'num' },
  IF: { min: 3, max: 3, args: 'num', returns: 'num' },
  MAX: { min: 1, max: 30, args: 'num', returns: 'num' },
  MIN: { min: 1, max: 30, args: 'num', returns: 'num' },
  NOT: { min: 1, max: 1, args: 'bool', returns: 'bool' },
  OR: { min: 1, max: 30, args: 'bool', returns: 'bool' },
  PERCENTILE: { min: 2, max: 2, args: 'num', returns: 'num' },
  PERIODCOUNT: { min: 0, max: 0, args: 'num', returns: 'num' },
  POWER: { min: 2, max: 2, args: 'num', returns: 'num' },
  RANK: { min: 1, max: 2, args: 'num', returns: 'num' },
  ROUND: { min: 1, max: 2, args: 'num', returns: 'num' },
  SQRT: { min: 1, max: 1, args: 'num', returns: 'num' },
  SUM: { min: 1, max: 30, args: 'num', returns: 'num' },
};

type TokenKind = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'end';
interface Token { kind: TokenKind; text: string; value: number; pos: number }

function syntax(detail: string): ReportingError {
  return new ReportingError('formula_syntax', detail);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    const rest = src.slice(i);
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      let value = Number(num[0]);
      let len = num[0].length;
      if (src.charAt(i + len) === '%') { value /= 100; len += 1; }
      out.push({ kind: 'num', text: src.slice(i, i + len), value, pos: i });
      i += len;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (ident) {
      out.push({ kind: 'ident', text: ident[0], value: 0, pos: i });
      i += ident[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ kind: 'op', text: two, value: 0, pos: i }); i += 2; continue; }
    if ('+-*/^=<>'.includes(c)) { out.push({ kind: 'op', text: c, value: 0, pos: i }); i += 1; continue; }
    if (c === '(') { out.push({ kind: 'lparen', text: c, value: 0, pos: i }); i += 1; continue; }
    if (c === ')') { out.push({ kind: 'rparen', text: c, value: 0, pos: i }); i += 1; continue; }
    if (c === ',') { out.push({ kind: 'comma', text: c, value: 0, pos: i }); i += 1; continue; }
    throw syntax(`unexpected "${c}" at ${i}`);
  }
  out.push({ kind: 'end', text: '', value: 0, pos: src.length });
  return out;
}

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    // The token list always ends with an `end` token, and `at` never passes it.
    return this.tokens[this.at] as Token;
  }

  private take(): Token {
    const tok = this.peek();
    if (tok.kind !== 'end') this.at += 1;
    return tok;
  }

  private isOp(...ops: string[]): boolean {
    const tok = this.peek();
    return tok.kind === 'op' && ops.includes(tok.text);
  }

  parse(): FormulaNode {
    const node = this.comparison(0);
    const tok = this.peek();
    if (tok.kind !== 'end') throw syntax(`unexpected "${tok.text}" at ${tok.pos}`);
    return node;
  }

  private comparison(depth: number): FormulaNode {
    if (depth > MAX_DEPTH) throw syntax('the formula is nested too deeply');
    const left = this.additive(depth);
    if (!this.isOp(...COMPARISONS)) return left;
    const op = this.take().text as FormulaBinaryOp;
    return { t: 'bin', op, l: left, r: this.additive(depth) };
  }

  private additive(depth: number): FormulaNode {
    let left = this.multiplicative(depth);
    while (this.isOp('+', '-')) {
      const op = this.take().text as FormulaBinaryOp;
      left = { t: 'bin', op, l: left, r: this.multiplicative(depth) };
    }
    return left;
  }

  private multiplicative(depth: number): FormulaNode {
    let left = this.unary(depth);
    while (this.isOp('*', '/')) {
      const op = this.take().text as FormulaBinaryOp;
      left = { t: 'bin', op, l: left, r: this.unary(depth) };
    }
    return left;
  }

  /** Unary minus binds looser than `^`, so `-2^2` is -4. */
  private unary(depth: number): FormulaNode {
    if (depth > MAX_DEPTH) throw syntax('the formula is nested too deeply');
    if (this.isOp('-')) { this.take(); return { t: 'neg', x: this.unary(depth + 1) }; }
    if (this.isOp('+')) { this.take(); return this.unary(depth + 1); }
    return this.power(depth);
  }

  /** Right-associative: `2^3^2` is 2^(3^2). */
  private power(depth: number): FormulaNode {
    const base = this.primary(depth);
    if (!this.isOp('^')) return base;
    this.take();
    return { t: 'bin', op: '^', l: base, r: this.unary(depth + 1) };
  }

  private primary(depth: number): FormulaNode {
    const tok = this.take();
    if (tok.kind === 'num') return { t: 'num', v: tok.value };
    if (tok.kind === 'lparen') {
      const inner = this.comparison(depth + 1);
      if (this.take().kind !== 'rparen') throw syntax(`missing ")" for the "(" at ${tok.pos}`);
      return inner;
    }
    if (tok.kind === 'ident') {
      if (this.peek().kind !== 'lparen') {
        if (tok.text.includes('.')) throw syntax(`"${tok.text}" at ${tok.pos} is not a measure name`);
        return { t: 'ref', key: tok.text };
      }
      const fn = tok.text.toUpperCase();
      if (!(FORMULA_FUNCTIONS as readonly string[]).includes(fn)) {
        throw new ReportingError('formula_unknown_function', `"${tok.text}" is not a function`);
      }
      this.take();
      const args: FormulaNode[] = [];
      if (this.peek().kind === 'rparen') { this.take(); return { t: 'call', fn: fn as FormulaFunction, args }; }
      for (;;) {
        args.push(this.comparison(depth + 1));
        const next = this.take();
        if (next.kind === 'rparen') break;
        if (next.kind !== 'comma') throw syntax(`expected "," or ")" at ${next.pos}`);
      }
      return { t: 'call', fn: fn as FormulaFunction, args };
    }
    throw syntax(tok.kind === 'end' ? 'the formula ends early' : `unexpected "${tok.text}" at ${tok.pos}`);
  }
}

function typeError(detail: string): ReportingError {
  return new ReportingError('formula_type', detail);
}

/** Checks arity and types, so the emitted SQL always binds. Returns the node's type. */
function check(node: FormulaNode): ValueType {
  switch (node.t) {
    case 'num':
    case 'ref':
      return 'num';
    case 'neg':
      if (check(node.x) !== 'num') throw typeError('"-" needs a number');
      return 'num';
    case 'bin': {
      if (check(node.l) !== 'num' || check(node.r) !== 'num') throw typeError(`"${node.op}" needs a number on both sides`);
      return COMPARISONS.includes(node.op) ? 'bool' : 'num';
    }
    case 'call': {
      const sig = SIGNATURES[node.fn];
      if (node.args.length < sig.min || node.args.length > sig.max) {
        const want = sig.min === sig.max ? `${sig.min}` : `${sig.min} to ${sig.max}`;
        throw new ReportingError('formula_arity', `${node.fn} takes ${want} argument(s), got ${node.args.length}`);
      }
      node.args.forEach((arg, i) => {
        const want: ValueType = node.fn === 'IF' ? (i === 0 ? 'bool' : 'num') : sig.args;
        if (check(arg) !== want) {
          throw typeError(`argument ${i + 1} of ${node.fn} must be a ${want === 'bool' ? 'condition' : 'number'}`);
        }
      });
      if (node.fn === 'ROUND' && node.args.length === 2) {
        const places = node.args[1];
        if (!places || places.t !== 'num' || !Number.isInteger(places.v) || places.v > 10) {
          throw typeError('the second argument of ROUND must be a whole number from 0 to 10');
        }
      }
      return sig.returns;
    }
  }
}

/** Parse and check a formula. The result is a number-valued expression over measures. */
export function parseFormula(source: string): FormulaNode {
  if (typeof source !== 'string' || source.trim() === '') throw new ReportingError('formula_empty', 'the formula is empty');
  if (source.length > FORMULA_MAX_CHARS) {
    throw new ReportingError('formula_too_long', `the formula is ${source.length} characters, the limit is ${FORMULA_MAX_CHARS}`);
  }
  const node = new Parser(tokenize(source)).parse();
  if (check(node) !== 'num') throw typeError('a formula must produce a number, not a condition');
  return node;
}

/** The measure keys a formula names, each once, in first-use order. */
export function formulaRefs(node: FormulaNode): string[] {
  const seen: string[] = [];
  const walk = (n: FormulaNode): void => {
    if (n.t === 'ref') { if (!seen.includes(n.key)) seen.push(n.key); return; }
    if (n.t === 'neg') { walk(n.x); return; }
    if (n.t === 'bin') { walk(n.l); walk(n.r); return; }
    if (n.t === 'call') n.args.forEach(walk);
  };
  walk(node);
  return seen;
}

export interface FormulaEmitContext {
  /** The SQL for one measure. Throw a ReportingError for a key that cannot be used. */
  measure: (key: string) => string;
  /** Days in the column's period, for DAYS(). */
  days?: number;
  /** Number of period columns in the view, for PERIODCOUNT(). */
  periodCount?: number;
}

/** Emit DuckDB SQL. Every division is guarded, so a zero divisor gives NULL, not an error. */
export function emitFormulaSql(node: FormulaNode, ctx: FormulaEmitContext): string {
  const emit = (n: FormulaNode): string => {
    switch (n.t) {
      case 'num':
        return sqlNumber(n.v);
      case 'ref':
        return `(${ctx.measure(n.key)})`;
      case 'neg':
        return `(-${emit(n.x)})`;
      case 'bin': {
        const l = emit(n.l);
        const r = emit(n.r);
        if (n.op === '/') return `(${l} / NULLIF(${r}, 0))`;
        if (n.op === '^') return `power(${l}, ${r})`;
        return `(${l} ${n.op} ${r})`;
      }
      case 'call':
        return emitCall(n.fn, n.args.map(emit));
    }
  };
  const emitCall = (fn: FormulaFunction, args: string[]): string => {
    const first = args[0] ?? 'NULL';
    switch (fn) {
      case 'ABS': return `abs(${first})`;
      case 'AND': return `(${args.join(' AND ')})`;
      case 'OR': return `(${args.join(' OR ')})`;
      case 'NOT': return `(NOT ${first})`;
      case 'SUM': return `(${args.map((a) => `COALESCE(${a}, 0)`).join(' + ')})`;
      case 'AVERAGE': {
        // Blanks are skipped, as a spreadsheet does: the divisor counts only the arguments that have a value.
        const total = args.map((a) => `COALESCE(${a}, 0)`).join(' + ');
        const present = args.map((a) => `(CASE WHEN ${a} IS NULL THEN 0 ELSE 1 END)`).join(' + ');
        return `((${total}) / NULLIF(${present}, 0))`;
      }
      case 'COALESCE': return `COALESCE(${args.join(', ')})`;
      case 'MAX': return `greatest(${args.join(', ')})`;
      case 'MIN': return `least(${args.join(', ')})`;
      case 'IF': return `(CASE WHEN ${first} THEN ${args[1] ?? 'NULL'} ELSE ${args[2] ?? 'NULL'} END)`;
      case 'POWER': return `power(${first}, ${args[1] ?? 'NULL'})`;
      case 'ROUND': return args.length === 2 ? `round(${first}, ${args[1] ?? '0'})` : `round(${first})`;
      case 'SQRT': return `(CASE WHEN ${first} >= 0 THEN sqrt(${first}) END)`;
      case 'FINITE': return `(CASE WHEN isfinite(CAST(${first} AS DOUBLE)) THEN ${first} ELSE ${args[1] ?? 'NULL'} END)`;
      case 'DAYS':
        if (ctx.days === undefined) throw new ReportingError('formula_function_unsupported', 'DAYS() needs a period');
        return sqlNumber(ctx.days);
      case 'PERIODCOUNT':
        if (ctx.periodCount === undefined) throw new ReportingError('formula_function_unsupported', 'PERIODCOUNT() needs a period view');
        return sqlNumber(ctx.periodCount);
      default:
        throw new ReportingError('formula_function_unsupported', `${fn} works across the grid and has no SQL form yet`);
    }
  };
  return emit(node);
}

/** True when the formula uses a function that only the grid can compute. */
export function usesGridOnlyFunction(node: FormulaNode): boolean {
  if (node.t === 'call') return GRID_ONLY.includes(node.fn) || node.args.some(usesGridOnlyFunction);
  if (node.t === 'neg') return usesGridOnlyFunction(node.x);
  if (node.t === 'bin') return usesGridOnlyFunction(node.l) || usesGridOnlyFunction(node.r);
  return false;
}

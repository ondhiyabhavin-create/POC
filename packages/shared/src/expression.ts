/**
 * Safe, spreadsheet-style formula language used by conditional rules.
 *
 *   [Debtor Type] = "I" AND LEN([SSN]) <> 9
 *   [C] + [D] > 100
 *   DAYS([Finalized Date], [Delinquency Date]) >= 60
 *
 * Column references use square brackets and may name the column letter ([C]),
 * its key ([ssn]) or its header ([Debtor Type]). Values are compared exactly;
 * blank cells are "" (and 0 in arithmetic, like Excel). There is no access to
 * JavaScript or the outside world — formulas are parsed into a small AST and
 * interpreted.
 */
import type { ColumnDefinition } from './types';

export type Value = string | number | boolean;

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'col'; index: number; ref: string }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: '-' | 'not'; e: Node };

export interface CompiledFormula {
  ok: true;
  source: string;
  ast: Node;
  /** Column keys referenced by the formula. */
  columns: string[];
}
export interface FormulaError {
  ok: false;
  source: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Function library (documented for the UI)
// ---------------------------------------------------------------------------

type Fn = { min: number; max: number; doc: string; example: string; impl: (a: Value[]) => Value };

const s = (v: Value): string => (typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : formatNumber(v));
const n = (v: Value): number => toNumber(v);

export const FUNCTIONS: Record<string, Fn> = {
  LEN: { min: 1, max: 1, doc: 'Number of characters', example: 'LEN([SSN]) = 9', impl: ([a]) => s(a).length },
  UPPER: { min: 1, max: 1, doc: 'Upper-case text', example: 'UPPER([State]) = "LA"', impl: ([a]) => s(a).toUpperCase() },
  LOWER: { min: 1, max: 1, doc: 'Lower-case text', example: 'LOWER([Email]) = [Email]', impl: ([a]) => s(a).toLowerCase() },
  TRIM: { min: 1, max: 1, doc: 'Remove surrounding spaces', example: 'TRIM([Name])', impl: ([a]) => s(a).trim() },
  LEFT: { min: 2, max: 2, doc: 'First N characters', example: 'LEFT([Zip Code], 2) = "70"', impl: ([a, b]) => s(a).slice(0, Math.max(0, n(b))) },
  RIGHT: { min: 2, max: 2, doc: 'Last N characters', example: 'RIGHT([Account], 4)', impl: ([a, b]) => (n(b) <= 0 ? '' : s(a).slice(-n(b))) },
  MID: { min: 3, max: 3, doc: 'N characters starting at position (1-based)', example: 'MID([ID], 3, 2)', impl: ([a, b, c]) => s(a).substr(Math.max(0, n(b) - 1), Math.max(0, n(c))) },
  CONCAT: { min: 1, max: 50, doc: 'Join text', example: 'CONCAT([First Name], " ", [Last Name])', impl: (a) => a.map(s).join('') },
  NUM: { min: 1, max: 1, doc: 'Convert text to a number (blank = 0)', example: 'NUM([Amount]) > 0', impl: ([a]) => toNumber(a) },
  ISBLANK: { min: 1, max: 1, doc: 'TRUE when blank', example: 'ISBLANK([FEIN])', impl: ([a]) => s(a).trim() === '' },
  ISNUMBER: { min: 1, max: 1, doc: 'TRUE when the value is a number', example: 'ISNUMBER([Amount])', impl: ([a]) => isNumeric(a) },
  ISDATE: { min: 1, max: 1, doc: 'TRUE when the value is a valid CCYY-MM-DD date', example: 'ISDATE([Judgement Date])', impl: ([a]) => isIsoDate(s(a)) },
  CONTAINS: { min: 2, max: 2, doc: 'Text contains part (ignores case)', example: 'CONTAINS([Description], "fine")', impl: ([a, b]) => s(a).toLowerCase().includes(s(b).toLowerCase()) },
  STARTSWITH: { min: 2, max: 2, doc: 'Text starts with part (ignores case)', example: 'STARTSWITH([Agency Debt ID], "CC")', impl: ([a, b]) => s(a).toLowerCase().startsWith(s(b).toLowerCase()) },
  ENDSWITH: { min: 2, max: 2, doc: 'Text ends with part (ignores case)', example: 'ENDSWITH([Email], ".gov")', impl: ([a, b]) => s(a).toLowerCase().endsWith(s(b).toLowerCase()) },
  MATCHES: { min: 2, max: 2, doc: 'Whole text matches a regular expression', example: 'MATCHES([Zip Code], "\\d{5}")', impl: ([a, b]) => safeRegex(s(b)).test(s(a)) },
  IN: { min: 2, max: 100, doc: 'Value equals one of the listed values', example: 'IN([Debtor Type], "I", "C")', impl: ([a, ...rest]) => rest.some((r) => valuesEqual(a, r)) },
  IF: { min: 3, max: 3, doc: 'IF(condition, value if true, value if false)', example: 'IF([Debtor Type] = "I", [SSN], [FEIN])', impl: ([c, a, b]) => (truthy(c) ? a : b) },
  AND: { min: 1, max: 50, doc: 'TRUE when all are true', example: 'AND([A] = "x", [B] > 1)', impl: (a) => a.every(truthy) },
  OR: { min: 1, max: 50, doc: 'TRUE when any is true', example: 'OR([A] = "x", [B] > 1)', impl: (a) => a.some(truthy) },
  NOT: { min: 1, max: 1, doc: 'Negate', example: 'NOT(ISBLANK([FEIN]))', impl: ([a]) => !truthy(a) },
  ABS: { min: 1, max: 1, doc: 'Absolute value', example: 'ABS([Adjustment Amount]) < 10000', impl: ([a]) => Math.abs(n(a)) },
  ROUND: { min: 1, max: 2, doc: 'Round to N decimals', example: 'ROUND([Rate] * 100, 2)', impl: ([a, d]) => round(n(a), d === undefined ? 0 : n(d)) },
  MIN: { min: 1, max: 50, doc: 'Smallest number', example: 'MIN([A], [B])', impl: (a) => Math.min(...a.map(n)) },
  MAX: { min: 1, max: 50, doc: 'Largest number', example: 'MAX([A], [B])', impl: (a) => Math.max(...a.map(n)) },
  SUM: { min: 1, max: 100, doc: 'Add numbers', example: 'SUM([BJ], [BK], [BL]) <= [BO]', impl: (a) => round(a.map(n).reduce((x, y) => x + y, 0), 10) },
  COALESCE: { min: 1, max: 50, doc: 'First non-blank value', example: 'COALESCE([SSN], [FEIN])', impl: (a) => a.find((v) => s(v).trim() !== '') ?? '' },
  TODAY: { min: 0, max: 0, doc: "Today's date (CCYY-MM-DD)", example: '[Recall Date] <= TODAY()', impl: () => isoToday() },
  DATE: { min: 1, max: 1, doc: 'Valid CCYY-MM-DD date, otherwise blank', example: 'DATE([Payment Date]) <> ""', impl: ([a]) => (isIsoDate(s(a).trim()) ? s(a).trim() : '') },
  DAYS: { min: 2, max: 2, doc: 'Days from start to end: DAYS(end, start)', example: 'DAYS([Finalized Date], [Delinquency Date]) >= 60', impl: ([e, st]) => daysBetween(s(st), s(e)) },
  ADDDAYS: { min: 2, max: 2, doc: 'Add N days to a date', example: '[Finalized Date] >= ADDDAYS([60 Day Letter Mail Date], 60)', impl: ([d, k]) => addDays(s(d), n(k)) },
  YEAR: { min: 1, max: 1, doc: 'Year of a date', example: 'YEAR([Date of Birth]) > 1900', impl: ([a]) => datePart(s(a), 0) },
  MONTH: { min: 1, max: 1, doc: 'Month of a date (1-12)', example: 'MONTH([Payment Date])', impl: ([a]) => datePart(s(a), 1) },
  DAY: { min: 1, max: 1, doc: 'Day of a date (1-31)', example: 'DAY([Payment Date])', impl: ([a]) => datePart(s(a), 2) },
};

export const FORMULA_OPERATORS = [
  { op: '+  -  *  /', doc: 'Arithmetic (blank counts as 0)' },
  { op: '&', doc: 'Join text' },
  { op: '=  <>  <  <=  >  >=', doc: 'Compare (numbers numerically, dates and text alphabetically, exact case)' },
  { op: 'AND  OR  NOT', doc: 'Combine conditions; use ( ) to group' },
  { op: '"text"  123  TRUE  FALSE', doc: 'Literal values' },
  { op: '[C]  [ssn]  [Debtor Type]', doc: 'Column by letter, key or header' },
];

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const NUMERIC_RE = /^-?(\d+\.?\d*|\.\d+)$/;

export function isNumeric(v: Value): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return false;
  return NUMERIC_RE.test(v.trim());
}

export function toNumber(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const t = v.trim();
  if (t === '') return 0;
  return NUMERIC_RE.test(t) ? Number(t) : NaN;
}

export function truthy(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  const t = v.trim().toUpperCase();
  return t !== '' && t !== 'FALSE' && t !== '0';
}

function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return '';
  return String(parseFloat(x.toPrecision(15)));
}

function round(x: number, d: number): number {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(d)));
  return Math.round((x + Number.EPSILON) * f) / f;
}

/** Equality: numbers compare numerically, everything else as exact text. Blank never equals a number. */
export function valuesEqual(a: Value, b: Value): boolean {
  const as = s(a);
  const bs = s(b);
  if (as.trim() !== '' && bs.trim() !== '' && isNumeric(a) && isNumeric(b)) return toNumber(a) === toNumber(b);
  return as === bs;
}

/** <0, 0, >0 — numbers numerically, otherwise text (CCYY-MM-DD dates sort correctly as text). */
export function compareValues(a: Value, b: Value): number {
  const as = s(a);
  const bs = s(b);
  if (as.trim() !== '' && bs.trim() !== '' && isNumeric(a) && isNumeric(b)) return toNumber(a) - toNumber(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function isIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(start: string, end: string): number {
  if (!isIsoDate(start.trim()) || !isIsoDate(end.trim())) return NaN;
  return Math.round((Date.parse(`${end.trim()}T00:00:00Z`) - Date.parse(`${start.trim()}T00:00:00Z`)) / 86400000);
}

function addDays(d: string, k: number): string {
  if (!isIsoDate(d.trim()) || !Number.isFinite(k)) return '';
  const dt = new Date(`${d.trim()}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + Math.trunc(k));
  return dt.toISOString().slice(0, 10);
}

function datePart(d: string, i: number): number {
  return isIsoDate(d.trim()) ? Number(d.trim().split('-')[i]) : NaN;
}

const regexCache = new Map<string, RegExp>();
export function safeRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      re = /(?!)/; // invalid pattern never matches (caught earlier by compile checks)
    }
    regexCache.set(pattern, re);
  }
  return re;
}

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

type Tok = { k: 'num' | 'str' | 'col' | 'id' | 'op' | 'eof'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const err = (msg: string, at = i) => {
    throw new FormulaSyntaxError(msg, at);
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) err('Invalid number');
      out.push({ k: 'num', v: m![0], pos: start });
      i += m![0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (true) {
        if (i >= src.length) err('Text is missing its closing quote', start);
        if (src[i] === c) {
          if (src[i + 1] === c) {
            v += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ k: 'str', v, pos: start });
      continue;
    }
    if (c === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) err('Column reference is missing its closing ]', start);
      out.push({ k: 'col', v: src.slice(i + 1, end).trim(), pos: start });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0].toUpperCase(), pos: start });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '==', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/&=<>(),!'.includes(c)) {
      out.push({ k: 'op', v: c, pos: start });
      i++;
      continue;
    }
    err(`Unexpected character "${c}"`);
  }
  out.push({ k: 'eof', v: '', pos: src.length });
  return out;
}

class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

export interface ColumnResolver {
  resolve(ref: string): { index: number; key: string } | undefined;
}

export function columnResolver(columns: ColumnDefinition[]): ColumnResolver {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byLetter = new Map(columns.map((c, i) => [c.letter.toUpperCase(), i]));
  const byKey = new Map(columns.map((c, i) => [c.key, i]));
  const byKeyLower = new Map(columns.map((c, i) => [c.key.toLowerCase(), i]));
  const byHeader = new Map<string, number>();
  columns.forEach((c, i) => {
    const h = norm(c.header);
    if (!byHeader.has(h)) byHeader.set(h, i); // first match wins for duplicate headers
  });
  return {
    resolve(ref: string) {
      const r = ref.trim();
      const i =
        (/^[A-Z]{1,3}$/.test(r) ? byLetter.get(r) : undefined) ??
        byKey.get(r) ??
        byKeyLower.get(r.toLowerCase()) ??
        byHeader.get(norm(r));
      return i === undefined ? undefined : { index: i, key: columns[i].key };
    },
  };
}

function parse(src: string, resolver: ColumnResolver, used: Set<string>): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (...ops: string[]) => peek().k === 'op' && ops.includes(peek().v);
  const isId = (...ids: string[]) => peek().k === 'id' && ids.includes(peek().v) && !(toks[p + 1]?.k === 'op' && toks[p + 1].v === '(');
  const expect = (v: string) => {
    if (!(peek().k === 'op' && peek().v === v)) throw new FormulaSyntaxError(`Expected "${v}"`, peek().pos);
    next();
  };

  const orExpr = (): Node => {
    let l = andExpr();
    while (isOp('||') || isId('OR')) {
      next();
      l = { t: 'bin', op: 'or', l, r: andExpr() };
    }
    return l;
  };
  const andExpr = (): Node => {
    let l = notExpr();
    while (isOp('&&') || isId('AND')) {
      next();
      l = { t: 'bin', op: 'and', l, r: notExpr() };
    }
    return l;
  };
  const notExpr = (): Node => {
    if (isOp('!') || isId('NOT')) {
      next();
      return { t: 'un', op: 'not', e: notExpr() };
    }
    return comparison();
  };
  const comparison = (): Node => {
    const l = concat();
    if (isOp('=', '==', '<>', '!=', '<', '<=', '>', '>=')) {
      let op = next().v;
      if (op === '==') op = '=';
      if (op === '!=') op = '<>';
      return { t: 'bin', op, l, r: concat() };
    }
    return l;
  };
  const concat = (): Node => {
    let l = additive();
    while (isOp('&')) {
      next();
      l = { t: 'bin', op: '&', l, r: additive() };
    }
    return l;
  };
  const additive = (): Node => {
    let l = mult();
    while (isOp('+', '-')) {
      const op = next().v;
      l = { t: 'bin', op, l, r: mult() };
    }
    return l;
  };
  const mult = (): Node => {
    let l = unary();
    while (isOp('*', '/')) {
      const op = next().v;
      l = { t: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      next();
      return { t: 'un', op: '-', e: unary() };
    }
    if (isOp('+')) {
      next();
      return unary();
    }
    return primary();
  };
  const primary = (): Node => {
    const tk = peek();
    if (tk.k === 'num') {
      next();
      return { t: 'num', v: Number(tk.v) };
    }
    if (tk.k === 'str') {
      next();
      return { t: 'str', v: tk.v };
    }
    if (tk.k === 'col') {
      next();
      const r = resolver.resolve(tk.v);
      if (!r) throw new FormulaSyntaxError(`Unknown column [${tk.v}]`, tk.pos);
      used.add(r.key);
      return { t: 'col', index: r.index, ref: tk.v };
    }
    if (tk.k === 'op' && tk.v === '(') {
      next();
      const e = orExpr();
      expect(')');
      return e;
    }
    if (tk.k === 'id') {
      next();
      if (peek().k === 'op' && peek().v === '(') {
        const fn = FUNCTIONS[tk.v];
        if (!fn) throw new FormulaSyntaxError(`Unknown function ${tk.v}()`, tk.pos);
        next();
        const args: Node[] = [];
        if (!(peek().k === 'op' && peek().v === ')')) {
          args.push(orExpr());
          while (peek().k === 'op' && peek().v === ',') {
            next();
            args.push(orExpr());
          }
        }
        expect(')');
        if (args.length < fn.min || args.length > fn.max) {
          const want = fn.min === fn.max ? `${fn.min}` : fn.max >= 50 ? `at least ${fn.min}` : `${fn.min}-${fn.max}`;
          throw new FormulaSyntaxError(`${tk.v}() takes ${want} argument(s), got ${args.length}`, tk.pos);
        }
        return { t: 'call', name: tk.v, args };
      }
      if (tk.v === 'TRUE') return { t: 'bool', v: true };
      if (tk.v === 'FALSE') return { t: 'bool', v: false };
      if (tk.v === 'BLANK') return { t: 'str', v: '' };
      throw new FormulaSyntaxError(`Unknown name "${tk.v}". Wrap column names in [ ] and text in " ".`, tk.pos);
    }
    if (tk.k === 'eof') throw new FormulaSyntaxError('Formula ends unexpectedly', tk.pos);
    throw new FormulaSyntaxError(`Unexpected "${tk.v}"`, tk.pos);
  };

  if (src.trim() === '') throw new FormulaSyntaxError('Formula is empty', 0);
  const ast = orExpr();
  if (peek().k !== 'eof') throw new FormulaSyntaxError(`Unexpected "${peek().v}"`, peek().pos);
  return ast;
}

export function compileFormula(source: string, columns: ColumnDefinition[] | ColumnResolver): CompiledFormula | FormulaError {
  const resolver = Array.isArray(columns) ? columnResolver(columns) : columns;
  const used = new Set<string>();
  try {
    const ast = parse(source, resolver, used);
    validateRegexArgs(ast);
    return { ok: true, source, ast, columns: [...used] };
  } catch (e) {
    const msg = e instanceof FormulaSyntaxError ? `${e.message} (at position ${e.pos + 1})` : (e as Error).message;
    return { ok: false, source, error: msg };
  }
}

function validateRegexArgs(node: Node) {
  if (node.t === 'call') {
    if (node.name === 'MATCHES' && node.args[1]?.t === 'str') {
      try {
        new RegExp(node.args[1].v);
      } catch {
        throw new Error(`MATCHES() pattern "${node.args[1].v}" is not a valid regular expression`);
      }
    }
    node.args.forEach(validateRegexArgs);
  } else if (node.t === 'bin') {
    validateRegexArgs(node.l);
    validateRegexArgs(node.r);
  } else if (node.t === 'un') validateRegexArgs(node.e);
}

export function evaluate(f: CompiledFormula, row: string[]): Value {
  return evalNode(f.ast, row);
}

function evalNode(node: Node, row: string[]): Value {
  switch (node.t) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v;
    case 'col':
      return (row[node.index] ?? '').trim();
    case 'un':
      return node.op === 'not' ? !truthy(evalNode(node.e, row)) : -toNumber(evalNode(node.e, row));
    case 'call': {
      // IF / AND / OR short-circuit
      if (node.name === 'IF') return truthy(evalNode(node.args[0], row)) ? evalNode(node.args[1], row) : evalNode(node.args[2], row);
      return FUNCTIONS[node.name].impl(node.args.map((a) => evalNode(a, row)));
    }
    case 'bin': {
      if (node.op === 'and') return truthy(evalNode(node.l, row)) && truthy(evalNode(node.r, row));
      if (node.op === 'or') return truthy(evalNode(node.l, row)) || truthy(evalNode(node.r, row));
      const l = evalNode(node.l, row);
      const r = evalNode(node.r, row);
      switch (node.op) {
        case '+':
          return round(toNumber(l) + toNumber(r), 10);
        case '-':
          return round(toNumber(l) - toNumber(r), 10);
        case '*':
          return toNumber(l) * toNumber(r);
        case '/':
          return toNumber(r) === 0 ? NaN : toNumber(l) / toNumber(r);
        case '&':
          return s(l) + s(r);
        case '=':
          return valuesEqual(l, r);
        case '<>':
          return !valuesEqual(l, r);
        case '<':
          return compareValues(l, r) < 0;
        case '<=':
          return compareValues(l, r) <= 0;
        case '>':
          return compareValues(l, r) > 0;
        case '>=':
          return compareValues(l, r) >= 0;
      }
    }
  }
  return '';
}

export function valueToString(v: Value): string {
  return s(v);
}

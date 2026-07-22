/**
 * A small, safe formula evaluator for formula columns. Same-row scalar
 * expressions only: arithmetic over other columns, referenced by name in
 * braces — `{Qty} * {Price}`, `ROUND({Total} * 0.15, 2)`, `IF({Paid}, 0, {Due})`.
 *
 * Deliberately NOT JavaScript `eval`: a hand-written tokenizer + recursive
 * descent parser over a tiny grammar (numbers, strings, `{refs}`, the operators
 * + - * / % ^, comparisons, and a fixed function set). No identifiers reach a
 * global scope, so a hostile formula can at worst return NaN.
 *
 * The scientific set (`^`, SQRT, POW, LN, LOG10, EXP, and the bare constants PI
 * and E) exists for engineering formulas, which are rarely expressible with the
 * four spreadsheet operations alone — a square root or an exponent term is the
 * norm rather than the exception once a formula comes out of a standard.
 *
 * Cross-row math (sum/avg of a whole column) is NOT a formula — that's the
 * aggregates footer (table-model.ts `computeAggregate`). Formulas see only the
 * current row.
 *
 * Imported by table-model.ts `resolveCell`; kept dependency-free and pure so it
 * runs unchanged in tool handlers, the API, and the browser.
 */
import type { CellValue, Row, TableDoc } from './table-model';

type FnName =
  | 'IF'
  | 'ROUND'
  | 'ABS'
  | 'MIN'
  | 'MAX'
  | 'SUM'
  | 'FLOOR'
  | 'CEIL'
  | 'CONCAT'
  | 'SQRT'
  | 'POW'
  | 'LN'
  | 'LOG10'
  | 'EXP';
const FUNCTIONS = new Set<FnName>([
  'IF',
  'ROUND',
  'ABS',
  'MIN',
  'MAX',
  'SUM',
  'FLOOR',
  'CEIL',
  'CONCAT',
  'SQRT',
  'POW',
  'LN',
  'LOG10',
  'EXP',
]);

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

export type EvalValue = number | string | boolean | null;

const MAX_FORMULA_LEN = 2000;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new Error('unterminated {column reference}');
      out.push({ t: 'ref', v: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error('unterminated string literal');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    // Numbers, including a leading-dot decimal (`.5`) and scientific notation
    // (`1e5`, `1.5E-6`, `6.02e+23`) — which is simply how constants out of an
    // engineering standard are written, and which previously tokenized as a
    // number followed by the `E` constant and died as "trailing tokens",
    // rendering a BLANK cell rather than an error.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9._]/.test(src[j]!)) j++;
      // Only consume `e`/`E` as an exponent when real digits follow, so a bare
      // `E` after a number stays the constant and fails loudly instead.
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) {
          while (k < n && isDigit(src[k])) k++;
          j = k;
        }
      }
      out.push({ t: 'num', v: Number(src.slice(i, j).replace(/_/g, '')) });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // Two-char comparison operators.
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '<>') {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    if ('+-*/%<>^'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '=') {
      out.push({ t: 'op', v: '==' });
      i++;
      continue;
    }
    if (c === '(') {
      out.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      out.push({ t: 'comma' });
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
  return out;
}

/**
 * How a `{braced}` reference resolves to a value. Table formulas bind refs to
 * columns of the current row; the formula-spec evaluator binds them to named
 * variables. Same grammar, same parser, two binding strategies — there is
 * deliberately only one expression language in the codebase.
 */
export type RefResolver = (name: string) => EvalValue;

class Parser {
  private pos = 0;
  constructor(
    private toks: Token[],
    private resolve: RefResolver,
  ) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }
  private expect(t: Token['t']): void {
    const tok = this.next();
    if (!tok || tok.t !== t) throw new Error(`expected ${t}`);
  }

  parse(): EvalValue {
    const v = this.parseComparison();
    if (this.pos < this.toks.length) throw new Error('trailing tokens');
    return v;
  }

  // comparison: addsub (op addsub)?
  private parseComparison(): EvalValue {
    let left = this.parseAddSub();
    const tok = this.peek();
    if (tok?.t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(tok.v)) {
      this.next();
      const right = this.parseAddSub();
      left = compare(tok.v, left, right);
    }
    return left;
  }

  private parseAddSub(): EvalValue {
    let left = this.parseMulDiv();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        this.next();
        const right = this.parseMulDiv();
        if (tok.v === '+') {
          // '+' concatenates when either side is a non-numeric string.
          if (typeof left === 'string' || typeof right === 'string') {
            left = `${toStr(left)}${toStr(right)}`;
          } else {
            left = toNum(left) + toNum(right);
          }
        } else {
          left = toNum(left) - toNum(right);
        }
      } else break;
    }
    return left;
  }

  private parseMulDiv(): EvalValue {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === 'op' && (tok.v === '*' || tok.v === '/' || tok.v === '%')) {
        this.next();
        const right = toNum(this.parseUnary());
        const l = toNum(left);
        left =
          tok.v === '*' ? l * right : tok.v === '/' ? (right === 0 ? NaN : l / right) : l % right;
      } else break;
    }
    return left;
  }

  private parseUnary(): EvalValue {
    const tok = this.peek();
    if (tok?.t === 'op' && tok.v === '-') {
      this.next();
      return -toNum(this.parseUnary());
    }
    if (tok?.t === 'op' && tok.v === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePow();
  }

  // Exponentiation binds tighter than * and /, AND tighter than unary minus —
  // which is what makes `-2^2` parse as -(2^2) = -4, following normal
  // mathematical convention. (Excel is the well-known counter-example: there
  // `=-2^2` is +4. We deliberately do not copy Excel here.) Right-associative,
  // so `2^3^2` is 2^9; the exponent re-enters parseUnary so `2^-1` is legal.
  private parsePow(): EvalValue {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok?.t === 'op' && tok.v === '^') {
      this.next();
      return toNum(base) ** toNum(this.parseUnary());
    }
    return base;
  }

  private parsePrimary(): EvalValue {
    const tok = this.next();
    if (!tok) throw new Error('unexpected end of formula');
    switch (tok.t) {
      case 'num':
        return tok.v;
      case 'str':
        return tok.v;
      case 'ref':
        return this.resolve(tok.v);
      case 'lparen': {
        const v = this.parseComparison();
        this.expect('rparen');
        return v;
      }
      case 'ident': {
        const upper = tok.v.toUpperCase();
        if (upper === 'TRUE') return true;
        if (upper === 'FALSE') return false;
        // Bare mathematical constants. Safe as identifiers because column
        // references are always braced — `PI` can never shadow a column.
        if (upper === 'PI') return Math.PI;
        if (upper === 'E') return Math.E;
        if (this.peek()?.t === 'lparen' && FUNCTIONS.has(upper as FnName)) {
          return this.parseCall(upper as FnName);
        }
        throw new Error(`unknown identifier '${tok.v}'`);
      }
      default:
        throw new Error('unexpected token');
    }
  }

  private parseCall(name: FnName): EvalValue {
    this.expect('lparen');
    const args: EvalValue[] = [];
    if (this.peek()?.t !== 'rparen') {
      args.push(this.parseComparison());
      while (this.peek()?.t === 'comma') {
        this.next();
        args.push(this.parseComparison());
      }
    }
    this.expect('rparen');
    return applyFn(name, args);
  }
}

/** Binds `{refs}` to columns of one row. */
function columnResolver(doc: TableDoc, row: Row): RefResolver {
  return (name) => {
    const col = doc.columns.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (!col) return null;
    // Guard against formula → formula recursion: a formula may not reference
    // another formula column (avoids cycles without a full dependency graph).
    if (col.type === 'formula') return null;
    return cellToEval(row.cells[col.id] ?? null);
  };
}

function cellToEval(v: CellValue): EvalValue {
  if (Array.isArray(v)) return v.join(', ');
  return v;
}

/**
 * Parse a numeric string the ONE way the whole evaluator agrees on.
 *
 * This existing exactly once matters. `toNum` used to strip thousands
 * separators while `compare` called bare `Number()`, so `'1,000'` was 1000 to
 * arithmetic and NaN to a comparison — and a NaN comparison silently falls
 * through to STRING ordering, where `'1,000' < '28.7'`. A piecewise branch
 * guarded by `{Ps} > {Ptrans}` therefore selected the wrong equation and
 * returned a plausible number from it. Any divergence here is a wrong-answer
 * bug, not a formatting quirk.
 */
function parseNumericString(s: string): number {
  return Number(s.replace(/[, ]/g, ''));
}

function toNum(v: EvalValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseNumericString(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return 0; // null / blank behaves as 0 in arithmetic
}

function toStr(v: EvalValue): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Exported so the formula-spec evaluator branches on exactly these rules. */
export function truthy(v: EvalValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '' && v.trim().toLowerCase() !== 'false';
  return false;
}

function compare(op: string, a: EvalValue, b: EvalValue): boolean {
  const coerce = (v: EvalValue): number =>
    typeof v === 'number' ? v : typeof v === 'string' ? parseNumericString(v) : Number(v);
  const na = coerce(a);
  const nb = coerce(b);
  const numeric = Number.isFinite(na) && Number.isFinite(nb);
  switch (op) {
    case '==':
      return numeric ? na === nb : toStr(a) === toStr(b);
    case '!=':
      return numeric ? na !== nb : toStr(a) !== toStr(b);
    case '>':
      return numeric ? na > nb : toStr(a) > toStr(b);
    case '<':
      return numeric ? na < nb : toStr(a) < toStr(b);
    case '>=':
      return numeric ? na >= nb : toStr(a) >= toStr(b);
    case '<=':
      return numeric ? na <= nb : toStr(a) <= toStr(b);
    default:
      return false;
  }
}

function applyFn(name: FnName, args: EvalValue[]): EvalValue {
  switch (name) {
    case 'IF':
      return truthy(args[0] ?? null) ? (args[1] ?? null) : (args[2] ?? null);
    case 'ROUND': {
      const n = toNum(args[0] ?? null);
      const d = args.length > 1 ? toNum(args[1]!) : 0;
      const f = 10 ** d;
      return Math.round(n * f) / f;
    }
    case 'FLOOR':
      return Math.floor(toNum(args[0] ?? null));
    case 'CEIL':
      return Math.ceil(toNum(args[0] ?? null));
    case 'ABS':
      return Math.abs(toNum(args[0] ?? null));
    case 'MIN':
      return Math.min(...args.map(toNum));
    case 'MAX':
      return Math.max(...args.map(toNum));
    case 'SUM':
      return args.map(toNum).reduce((a, b) => a + b, 0);
    case 'CONCAT':
      return args.map(toStr).join('');
    // Scientific set. Out-of-domain inputs (SQRT of a negative, LN of zero)
    // yield NaN or -Infinity, which evalFormula collapses to null — a formula
    // outside its valid range renders blank rather than showing a bogus number.
    case 'SQRT':
      return Math.sqrt(toNum(args[0] ?? null));
    case 'POW':
      return toNum(args[0] ?? null) ** toNum(args[1] ?? null);
    case 'LN':
      return Math.log(toNum(args[0] ?? null));
    case 'LOG10':
      return Math.log10(toNum(args[0] ?? null));
    case 'EXP':
      return Math.exp(toNum(args[0] ?? null));
    default:
      return null;
  }
}

/**
 * Evaluate an expression against an arbitrary reference resolver, THROWING on
 * a malformed expression. Callers that want a value or a diagnosis — the
 * formula-spec evaluator, where a silently blank release rate would be worse
 * than a loud failure — use this. Callers that want a cell to render want
 * `evalFormula` below.
 */
export function evalExpression(src: string, resolve: RefResolver): EvalValue {
  const text = (src ?? '').trim();
  if (!text) throw new Error('empty expression');
  if (text.length > MAX_FORMULA_LEN) throw new Error('expression too long');
  return new Parser(tokenize(text), resolve).parse();
}

/**
 * Evaluate a formula expression in the context of one row. Returns a number,
 * string, or null. Any parse/eval error yields null (a broken formula renders
 * blank, never throws into the caller). NaN results collapse to null too.
 */
export function evalFormula(formula: string, doc: TableDoc, row: Row): CellValue {
  try {
    const result = evalExpression(formula, columnResolver(doc, row));
    if (typeof result === 'number') return Number.isFinite(result) ? result : null;
    if (typeof result === 'boolean') return result;
    return result ?? null;
  } catch {
    return null;
  }
}

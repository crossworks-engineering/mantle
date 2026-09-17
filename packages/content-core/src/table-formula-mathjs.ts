/**
 * The mathjs-backed formula engine — the replacement for the hand-written
 * parser in `table-formula.ts`, sharing its exact public shape so `resolveCell`
 * can switch between them and a differential test can run both.
 *
 * WHY REPLACE A WORKING PARSER: units. `table-formula.ts` treats a unit as a
 * string in a comment; mathjs treats it as part of the value. That is the
 * difference between `32.2 lbm ft/(lbf s^2)` (dimensionless, ~1.0008, correct)
 * and `32.2 ft/s^2` (an acceleration, wrong) — a mislabel that cost a real
 * audit finding and would silently scale every SI conversion by 3.13.
 *
 * THE OVERRIDE HAZARD, stated up front because it is easy to reintroduce:
 * mathjs is strict about types, and that strictness is exactly what makes unit
 * checking work. Every loosening we add is in tension with it. The first
 * attempt at this module extended `add` to concatenate strings and thereby
 * broke `1 ft + 2 ft` — silently disabling the feature we adopted mathjs for.
 * So the rules here are deliberately conservative:
 *
 *   - `add` is NEVER touched. String joining is `CONCAT`, as in Excel (`&`) and
 *     Airtable (`CONCATENATE`). `{Name} + '!'` is an error, not a concatenation.
 *   - Blank / unknown references resolve to 0 in the SCOPE, before mathjs sees
 *     them, so spreadsheet ergonomics cost nothing at the type layer.
 *   - Only the comparison operators are extended, because `IF({S} == 'Done', …)`
 *     is a genuine table need and mathjs compares numbers only.
 *
 * `table-formula-mathjs.test.ts` asserts unit arithmetic still works after
 * every one of those overrides. If a future signature breaks dimensional
 * checking, that suite fails rather than the feature quietly dying.
 */
import { create, all, type FactoryFunctionMap, type MathJsInstance } from 'mathjs';

/**
 * Two gaps in mathjs's own type definitions, narrowed here rather than cast at
 * each use so the unsafety is visible in one place:
 *  - `all` is declared `FactoryFunctionMap | undefined`, though it is always
 *    defined for the published build.
 *  - `typed(name, ...signatureMaps)` accepts several maps at runtime — which is
 *    how a function is EXTENDED rather than replaced — but the .d.ts declares
 *    only two parameters.
 */
const ALL_FACTORIES = all as FactoryFunctionMap;
type TypedExtend = (
  name: string,
  ...signatures: Array<Record<string, unknown>>
) => (...args: unknown[]) => unknown;
import type { CellValue, Row, TableDoc } from './table-model';
import type { EvalValue, RefResolver } from './table-formula';

const MAX_FORMULA_LEN = 2000;
/** Compiled-expression cache. `resolveCell` runs per cell per render, so
 *  re-parsing on every call would make a large grid crawl. */
const MAX_COMPILED = 500;

type Engine = {
  math: MathJsInstance;
  /** Captured BEFORE the escape hatches are disabled — see `build`. */
  compile: (expr: string) => { evaluate: (scope: Record<string, unknown>) => unknown };
};
let instance: Engine | null = null;

/** Compare two values our way: numerically when both look numeric (thousands
 *  separators included), lexically otherwise. Mirrors `compare` in
 *  table-formula.ts so the two engines agree. */
function cmp(a: unknown, b: unknown): number {
  const toNum = (v: unknown): number => Number(String(v).replace(/[, ]/g, ''));
  const na = toNum(a);
  const nb = toNum(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '' && v.trim().toLowerCase() !== 'false';
  return false;
}

function textOf(math: MathJsInstance, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return math.format(v, { precision: 14 });
}

function build(): Engine {
  const math = create(ALL_FACTORIES, { predictable: false });
  const typed = math.typed as unknown as TypedExtend;

  // Comparison operators: keep every existing signature and ADD string-aware
  // ones. Passing the original signature map is what extends rather than
  // replaces — replacing is how the first attempt broke unit arithmetic.
  const relational: Array<[string, (order: number) => boolean]> = [
    ['equal', (o) => o === 0],
    ['unequal', (o) => o !== 0],
    ['larger', (o) => o > 0],
    ['largerEq', (o) => o >= 0],
    ['smaller', (o) => o < 0],
    ['smallerEq', (o) => o <= 0],
  ];
  const overrides: Record<string, unknown> = {};
  for (const [name, accept] of relational) {
    const base = (math as unknown as Record<string, { signatures: Record<string, unknown> }>)[name];
    if (!base?.signatures) continue; // never silently ship a half-extended operator
    overrides[name] = typed(name, base.signatures, {
      'string, string': (a: string, b: string) => accept(cmp(a, b)),
      'string, number': (a: string, b: number) => accept(cmp(a, b)),
      'number, string': (a: number, b: string) => accept(cmp(a, b)),
      'string, boolean': (a: string, b: boolean) => accept(cmp(a, b)),
      'boolean, string': (a: boolean, b: string) => accept(cmp(a, b)),
    });
  }

  // Uppercase aliases — the documented table vocabulary. These are plain
  // imports: they add names, they do not alter how any type is handled.
  Object.assign(overrides, {
    IF: (c: unknown, a: unknown, b: unknown) => (truthy(c) ? a : b),
    CONCAT: (...xs: unknown[]) => xs.map((x) => textOf(math, x)).join(''),
    SQRT: (x: number) => Math.sqrt(x),
    ABS: (x: number) => Math.abs(x),
    ROUND: (x: number, d = 0) => {
      const f = 10 ** d;
      return Math.round(x * f) / f;
    },
    FLOOR: (x: number) => Math.floor(x),
    CEIL: (x: number) => Math.ceil(x),
    MIN: (...xs: number[]) => Math.min(...xs),
    MAX: (...xs: number[]) => Math.max(...xs),
    SUM: (...xs: number[]) => xs.reduce((a, b) => a + b, 0),
    LN: (x: number) => Math.log(x),
    LOG10: (x: number) => Math.log10(x),
    EXP: (x: number) => Math.exp(x),
    POW: (a: number, b: number) => a ** b,
    PI: Math.PI,
    E: Math.E,
  });

  math.import(overrides, { override: true });

  // Capture `compile` BEFORE disabling anything. `compile` uses `parse`
  // internally, so disabling `parse` on the instance disables our own
  // compilation too — the first cut of this module did exactly that and every
  // single expression returned blank. Holding a reference taken beforehand
  // keeps compilation working while the names stay unreachable FROM an
  // expression (verified: `evaluate("1+1")` inside a formula throws).
  const compile = math.compile.bind(math) as Engine['compile'];

  // Hard-disable the escape hatches mathjs's own security guidance names.
  // Nothing here needs them, and leaving them reachable from a user-authored
  // formula is the difference between an expression language and a runtime.
  // (Property access like `(1).constructor` is already refused by mathjs.)
  math.import(
    {
      import: () => {
        throw new Error('disabled');
      },
      createUnit: () => {
        throw new Error('disabled');
      },
      evaluate: () => {
        throw new Error('disabled');
      },
      parse: () => {
        throw new Error('disabled');
      },
      simplify: () => {
        throw new Error('disabled');
      },
      derivative: () => {
        throw new Error('disabled');
      },
    },
    { override: true },
  );

  return { math, compile };
}

function engine(): Engine {
  if (!instance) instance = build();
  return instance;
}

const compiled = new Map<string, { evaluate: (scope: Record<string, unknown>) => unknown }>();

/**
 * Rewrite `{Column Name}` references to safe identifiers, returning the
 * rewritten source and the ref names in binding order. Column names are
 * arbitrary user text, so they can never be pasted into the expression.
 */
function extractRefs(src: string): { code: string; refs: string[] } {
  const refs: string[] = [];
  const code = src.replace(/\{([^}]*)\}/g, (_m, name: string) => {
    const trimmed = String(name).trim();
    let index = refs.indexOf(trimmed);
    if (index < 0) index = refs.push(trimmed) - 1;
    return `__r${index}`;
  });
  return { code, refs };
}

/** Map a mathjs result back to something a cell can hold. A Unit, Matrix,
 *  BigNumber or Complex has no cell representation, so it renders blank rather
 *  than as a misleading `[object Object]`. */
function toCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  return null;
}

/** Evaluate against an arbitrary resolver, throwing on a malformed expression.
 *  The mathjs twin of `evalExpression` in table-formula.ts. */
export function evalExpressionMath(src: string, resolve: RefResolver): EvalValue {
  const text = (src ?? '').trim();
  if (!text) throw new Error('empty expression');
  if (text.length > MAX_FORMULA_LEN) throw new Error('expression too long');

  const { code, refs } = extractRefs(text);
  let entry = compiled.get(code);
  if (!entry) {
    entry = engine().compile(code);
    if (compiled.size >= MAX_COMPILED) compiled.clear();
    compiled.set(code, entry);
  }

  const scope: Record<string, unknown> = {};
  refs.forEach((name, i) => {
    const raw = resolve(name);
    // Spreadsheet ergonomics, applied HERE rather than in the type system: a
    // blank or unknown cell is 0. Doing it in the scope keeps `add` pristine,
    // so unit arithmetic is untouched by the convenience.
    scope[`__r${i}`] = raw === null || raw === undefined || raw === '' ? 0 : raw;
  });

  const result = entry.evaluate(scope);
  return (result ?? null) as EvalValue;
}

/** Binds `{refs}` to columns of one row — the mathjs twin of `columnResolver`. */
function columnResolver(doc: TableDoc, row: Row): RefResolver {
  return (name) => {
    const col = doc.columns.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (!col) return null;
    if (col.type === 'formula') return null; // no formula → formula chaining
    const raw = row.cells[col.id] ?? null;
    return Array.isArray(raw) ? raw.join(', ') : raw;
  };
}

/** Drop-in replacement for `evalFormula`: a broken formula renders blank. */
export function evalFormulaMath(formula: string, doc: TableDoc, row: Row): CellValue {
  try {
    return toCellValue(evalExpressionMath(formula, columnResolver(doc, row)));
  } catch {
    return null;
  }
}

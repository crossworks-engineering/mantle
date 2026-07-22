/**
 * Dimensional analysis for a FormulaSpec — the reason mathjs is in this repo.
 *
 * Until now `unit` was a string carried for display. This turns it into a
 * constraint: evaluate each expression with unit-bearing quantities and check
 * the result's dimension against the declared one. A dropped term inside a
 * `sqrt`, a mislabelled constant, a gauge/absolute mix-up — all change the
 * result's dimension, and all are otherwise invisible until someone
 * recomputes by hand.
 *
 * The motivating case is real: `g_c` was recorded as `ft/s2` when it is the
 * gravitational conversion constant `lbm ft/(lbf s^2)`. Numerically identical
 * in USC, so every test passed and every number was right — and any SI port
 * would have been silently out by a factor of 3.13. This check rejects it.
 *
 * Reported SEPARATELY from `parseFormulaSpec`, like `checkLookupCoverage`:
 * units are optional, older specs carry prose, and an unlabelled spec is
 * incomplete rather than invalid.
 */
import { create, all, type FactoryFunctionMap, type MathJsInstance } from 'mathjs';
import type { FormulaSpec, SpecVariable } from './formula-spec';

const ALL_FACTORIES = all as FactoryFunctionMap;

let instance: {
  math: MathJsInstance;
  compile: (e: string) => { evaluate: (s: Record<string, unknown>) => unknown };
} | null = null;

function engine() {
  if (!instance) {
    const math = create(ALL_FACTORIES, { predictable: false });
    // The uppercase vocabulary, bound to mathjs's OWN unit-aware functions.
    // Deliberately not the same implementations as the table engine, which
    // uses Math.sqrt so that an out-of-domain input yields NaN and renders a
    // blank cell. Here `sqrt` must understand units — sqrt(lb^2/s^2) is lb/s,
    // and that is the whole point.
    math.import(
      {
        SQRT: math.sqrt,
        ABS: math.abs,
        MIN: math.min,
        MAX: math.max,
        SUM: math.add,
        ROUND: (x: unknown) => x, // rounding cannot change a dimension
        FLOOR: (x: unknown) => x,
        CEIL: (x: unknown) => x,
        POW: math.pow,
        LN: math.log,
        LOG10: math.log10,
        EXP: math.exp,
        IF: (_c: unknown, a: unknown) => a, // both branches must share a dimension
        PI: Math.PI,
        E: Math.E,
      },
      { override: true },
    );
    const compile = math.compile.bind(math) as (e: string) => {
      evaluate: (s: Record<string, unknown>) => unknown;
    };
    instance = { math, compile };
  }
  return instance;
}

/**
 * Normalise a human-written unit into something mathjs parses.
 *
 * Specs are transcribed from printed tables, where units are written for
 * people: `lbm-ft/(lbf-s2)`, `lb/ft3`, `lbf/in2 (abs)`. Rejecting those would
 * mean retyping every spec in mathjs syntax, so the common conventions are
 * translated instead — hyphen-as-multiply, implicit exponents, and the
 * parenthetical qualifiers (abs/g/gauge) that carry a pressure BASIS rather
 * than a dimension.
 */
export function normaliseUnit(raw: string): string | null {
  let u = raw.trim();
  if (!u) return null;
  // Drop trailing qualifiers: "lbf/in2 (abs)" → "lbf/in2". The basis matters
  // enormously (see the gauge/absolute finding) but it is not a dimension, so
  // it cannot be expressed here — that is what two distinct symbols are for.
  u = u.replace(/\s*\((?:abs|absolute|g|gauge|a)\)\s*$/i, '').trim();
  if (!u || u === '-' || /^unitless$/i.test(u)) return null;
  // Hyphen between unit tokens means multiply: "lbm-ft" → "lbm ft".
  u = u.replace(/(?<=[A-Za-z0-9)])-(?=[A-Za-z])/g, ' ');
  // Implicit exponent: "ft3" → "ft^3", "in2" → "in^2", "s2" → "s^2".
  u = u.replace(/([A-Za-z])(\d+)(?![\d^])/g, '$1^$2');
  // Common spellings mathjs does not use.
  u = u.replace(/\bsec\b/g, 's').replace(/\bmol\b/g, 'mol');
  // Rankine is `degR`; a bare "R" would parse as roentgen.
  u = u.replace(/^°?R$/, 'degR').replace(/·/g, ' ');
  return u;
}

/** A quantity of 1 in the given unit, or null if it isn't parseable. */
function unitQuantity(math: MathJsInstance, raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  const norm = normaliseUnit(raw);
  if (!norm) return null;
  try {
    return math.evaluate(`1 ${norm}`);
  } catch {
    return null;
  }
}

export interface DimensionIssue {
  /** Expression (or derived-variable) id the problem belongs to. */
  id: string;
  kind: 'mismatch' | 'unparseable-unit' | 'inconsistent';
  declared: string | null;
  actual: string | null;
  detail: string;
}

function refsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\{([^}]*)\}/g)) {
    const name = (m[1] ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Check every expression that declares a result unit. Returns one issue per
 * problem; an empty array means every declared unit is consistent with the
 * arithmetic that produces it.
 */
export function checkDimensions(spec: FormulaSpec): DimensionIssue[] {
  const issues: DimensionIssue[] = [];
  const { math, compile } = engine();
  const bySymbol = new Map<string, SpecVariable>();
  for (const v of spec.variables) bySymbol.set(v.symbol, v);

  // Surface a unit we cannot read ONCE per variable, rather than as a cascade
  // of confusing mismatches downstream.
  for (const v of spec.variables) {
    if (!v.unit) continue;
    const norm = normaliseUnit(v.unit);
    if (norm && unitQuantity(math, v.unit) === null) {
      issues.push({
        id: v.symbol,
        kind: 'unparseable-unit',
        declared: v.unit,
        actual: null,
        detail: `could not interpret the unit '${v.unit}' (read as '${norm}') — dimensional checking skipped for anything using it`,
      });
    }
  }

  for (const expr of spec.expressions) {
    if (!expr.unit) continue;
    const expected = unitQuantity(math, expr.unit);
    if (expected === null) {
      issues.push({
        id: expr.id,
        kind: 'unparseable-unit',
        declared: expr.unit,
        actual: null,
        detail: `could not interpret the declared result unit '${expr.unit}'`,
      });
      continue;
    }

    // Bind each reference to 1-of-its-unit. Magnitudes are irrelevant — only
    // dimensions are under test — but a variable with no unit binds as a plain
    // 1 so a partially-annotated spec still checks what it can.
    const scope: Record<string, unknown> = {};
    let code = expr.expression;
    let skip = false;
    refsOf(expr.expression).forEach((name, i) => {
      const variable = bySymbol.get(name);
      const q = unitQuantity(math, variable?.unit ?? null);
      if (variable?.unit && q === null) skip = true;
      scope[`__d${i}`] = q ?? 1;
      code = code.split(`{${name}}`).join(`__d${i}`);
    });
    if (skip) continue; // already reported as unparseable above

    let actual: unknown;
    try {
      actual = compile(code).evaluate(scope);
    } catch (err) {
      issues.push({
        id: expr.id,
        kind: 'inconsistent',
        declared: expr.unit,
        actual: null,
        detail: `the expression is not dimensionally consistent: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    // `equalBase` is the real test: same dimension, regardless of magnitude or
    // prefix. Comparing formatted strings would reject ft vs in.
    try {
      const a = actual as { equalBase?: (o: unknown) => boolean; toString: () => string };
      const same =
        typeof a?.equalBase === 'function'
          ? a.equalBase(expected)
          : // A dimensionless result vs a declared unit: only equal if the
            // declared unit is itself dimensionless.
            typeof actual === 'number' &&
            typeof (expected as { equalBase?: unknown }).equalBase !== 'function';
      if (!same) {
        issues.push({
          id: expr.id,
          kind: 'mismatch',
          declared: expr.unit,
          actual: typeof actual === 'number' ? 'dimensionless' : String(a?.toString?.() ?? actual),
          detail: `declares '${expr.unit}' but the arithmetic produces ${
            typeof actual === 'number' ? 'a dimensionless value' : `'${a.toString()}'`
          } — a term is missing, or a variable's unit is wrong`,
        });
      }
    } catch (err) {
      issues.push({
        id: expr.id,
        kind: 'inconsistent',
        declared: expr.unit,
        actual: null,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return issues;
}

/**
 * A general calculator — the thing an agent reaches for instead of doing
 * arithmetic in its head.
 *
 * Models are reliable at reading the structure of a calculation and unreliable
 * at evaluating it; the failure is silent, because a wrong number looks exactly
 * like a right one. This exists so no agent ever has to compute. It is
 * unit-aware, so `2 ft + 3 in` and `100 lbf/in^2 to kPa` work, and a
 * dimensionally impossible request is an error rather than a plausible number.
 *
 * A SEPARATE mathjs instance from `table-formula-mathjs.ts`, deliberately.
 * That one loosens comparisons and treats blanks as zero for spreadsheet
 * ergonomics; a calculator must have none of that — strict types are what make
 * the unit checking trustworthy.
 */
import { create, all, type FactoryFunctionMap, type MathJsInstance } from 'mathjs';

const ALL_FACTORIES = all as FactoryFunctionMap;

const MAX_EXPRESSION_LEN = 1000;
/** Bounds a formatted result so a pathological expression can't return
 *  megabytes into an agent's context. */
const MAX_RESULT_LEN = 4000;

type Compiled = { evaluate: (scope: Record<string, unknown>) => unknown };
type Engine = {
  math: MathJsInstance;
  compile: (expr: string) => Compiled;
  parse: (expr: string) => { filter: (fn: (node: { type: string }) => boolean) => unknown[] };
};

let instance: Engine | null = null;

function build(): Engine {
  const math = create(ALL_FACTORIES, { predictable: false });

  // Captured BEFORE the escape hatches are disabled: `compile` and `parse` are
  // implemented in terms of the instance's own `parse`, so disabling it first
  // would disable our own use of them too.
  const compile = math.compile.bind(math) as Engine['compile'];
  const parse = math.parse.bind(math) as unknown as Engine['parse'];

  const deny = (name: string) => () => {
    throw new Error(`${name} is not available here`);
  };
  math.import(
    {
      import: deny('import'),
      createUnit: deny('createUnit'),
      evaluate: deny('evaluate'),
      parse: deny('parse'),
      simplify: deny('simplify'),
      derivative: deny('derivative'),
    },
    { override: true },
  );

  return { math, compile, parse };
}

function engine(): Engine {
  if (!instance) instance = build();
  return instance;
}

export type CalcResult =
  | {
      ok: true;
      /** Formatted result, units included — e.g. "3.173 lbm / s". */
      result: string;
      /** Plain number when the result is dimensionless, else null. */
      value: number | null;
      /** Unit string when the result carries one, else null. */
      unit: string | null;
    }
  | { ok: false; error: string };

export type CalcOptions = {
  /** Convert the result to this unit, e.g. "kPa". A dimensional mismatch is an
   *  error — which is the point. */
  to?: string;
  /** Significant digits in the formatted result. */
  precision?: number;
};

/**
 * Evaluate one expression. Never throws — a bad expression is a returned error,
 * because a calculator that throws into an agent loop just produces a retry
 * with the same input.
 */
export function calculate(expression: string, opts: CalcOptions = {}): CalcResult {
  const src = (expression ?? '').trim();
  if (!src) return { ok: false, error: 'expression is required' };
  if (src.length > MAX_EXPRESSION_LEN) {
    return { ok: false, error: `expression too long (max ${MAX_EXPRESSION_LEN} characters)` };
  }

  const { math, compile, parse } = engine();

  // Refuse assignment and function definition. Neither has any place in a
  // one-shot calculation, and a defined function is a way to build something
  // that runs for a long time.
  try {
    const node = parse(src);
    const assignments = node.filter(
      (n) => n.type === 'AssignmentNode' || n.type === 'FunctionAssignmentNode',
    );
    if (assignments.length > 0) {
      return {
        ok: false,
        error:
          'assignment is not supported — pass a single expression to evaluate, e.g. "2 * (3 + 4)"',
      };
    }
  } catch (err) {
    return { ok: false, error: `could not parse: ${err instanceof Error ? err.message : String(err)}` };
  }

  let value: unknown;
  try {
    value = compile(src).evaluate({});
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (opts.to) {
    try {
      value = math.unit(math.format(value)).to(opts.to);
    } catch {
      // Try the direct path too — `.to` exists on Unit but not on a plain number.
      try {
        value = (value as { to: (u: string) => unknown }).to(opts.to);
      } catch (err) {
        return {
          ok: false,
          error: `cannot convert the result to '${opts.to}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
  }

  const formatted = math.format(value, { precision: opts.precision ?? 14 });
  if (formatted.length > MAX_RESULT_LEN) {
    return { ok: false, error: 'result too large to return' };
  }

  // Split a unit-bearing result into its parts so a caller can use the number
  // without re-parsing the string.
  let numeric: number | null = null;
  let unit: string | null = null;
  if (typeof value === 'number') {
    numeric = Number.isFinite(value) ? value : null;
  } else if (value && typeof value === 'object' && 'toNumber' in value) {
    const u = value as { toNumber: (u?: string) => number; formatUnits?: () => string };
    try {
      numeric = u.toNumber();
    } catch {
      numeric = null;
    }
    unit = typeof u.formatUnits === 'function' ? u.formatUnits() : null;
  }

  return { ok: true, result: formatted, value: numeric, unit };
}

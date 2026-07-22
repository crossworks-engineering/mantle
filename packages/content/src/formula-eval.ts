/**
 * Evaluator for a FormulaSpec. Pure — no I/O, no DB, no clock.
 *
 * Two behaviours that deliberately differ from table formula columns:
 *
 * 1. IT FAILS LOUD. `evalFormula` returns null on any problem, which is right
 *    for a spreadsheet cell: a broken formula renders blank and the user moves
 *    on. It is wrong here. A blank release rate on a risk assessment looks like
 *    a small number, and an unresolved symbol silently reading as zero is how a
 *    calculation gets quietly wrong for a year. Every failure returns an
 *    explicit error instead.
 *
 * 2. SYMBOLS ARE CASE-SENSITIVE. Table columns match case-insensitively, which
 *    is friendly for `{qty}` vs `{Qty}`. Engineering notation does not have
 *    that luxury — in the vapour equations `k` is the specific heat ratio and
 *    `K` is a correction factor. A near-miss must be an error, not a guess.
 *
 * Every evaluation returns a trace: which branch was taken, which lookup row
 * matched, what each symbol resolved to. An engineering number that cannot be
 * explained is not worth much, and the trace is what lets a result be shown
 * with its derivation rather than asserted.
 */
import { evalExpression, truthy, type EvalValue, type RefResolver } from './table-formula';
import type { FormulaSpec, FormulaValue, SpecLookup } from './formula-spec';

export type TraceStep =
  | {
      kind: 'symbol';
      symbol: string;
      value: FormulaValue;
      from: 'input' | 'constant' | 'default' | 'derived' | 'produced';
      expression?: string;
    }
  | { kind: 'expression'; id: string; expression: string; value: FormulaValue; equation?: string }
  | { kind: 'branch'; id: string; when: string; chose: string; label?: string }
  | {
      kind: 'lookup';
      id: string;
      key: Record<string, FormulaValue>;
      value: FormulaValue;
      row?: Record<string, FormulaValue>;
    };

export type EvalResult =
  | { ok: true; value: FormulaValue; trace: TraceStep[] }
  | { ok: false; error: string; trace: TraceStep[] };

class SpecError extends Error {}

class SpecEvaluator {
  private cache = new Map<string, EvalValue>();
  private resolving = new Set<string>();
  private resolvingTargets = new Set<string>();
  readonly trace: TraceStep[] = [];
  /** resultSymbol → ids of targets declaring it, for chaining. */
  private producers = new Map<string, string[]>();

  constructor(
    private spec: FormulaSpec,
    private inputs: Record<string, FormulaValue>,
  ) {
    const claim = (symbol: string | undefined, id: string) => {
      if (!symbol) return;
      this.producers.set(symbol, [...(this.producers.get(symbol) ?? []), id]);
    };
    for (const e of spec.expressions) claim(e.resultSymbol, e.id);
    for (const p of spec.piecewise) claim(p.resultSymbol, p.id);
    for (const l of spec.lookups) claim(l.resultSymbol, l.id);
  }

  private resolver: RefResolver = (name) => this.resolveSymbol(name);

  private resolveSymbol(symbol: string): EvalValue {
    if (this.cache.has(symbol)) return this.cache.get(symbol)!;
    if (this.resolving.has(symbol)) {
      throw new SpecError(
        `circular reference resolving '${symbol}' (via ${[...this.resolving].join(' → ')})`,
      );
    }

    // A supplied input always wins, so a caller can override a constant or
    // short-circuit a chain by handing in a value computed elsewhere.
    //
    // But an EMPTY input is not a supplied one. `Object.hasOwn` alone would
    // treat `{"Pgauge": null}` as provided, and `toNum(null)` is 0 — so a form
    // with a blank field, or a JSON body carrying an explicit null, produced a
    // release rate of exactly zero reported as success. That is precisely the
    // silent-zero failure this module exists to prevent, so null / undefined /
    // '' are treated as absent and fall through to the missing-input error.
    if (Object.hasOwn(this.inputs, symbol)) {
      const supplied = this.inputs[symbol];
      const blank = supplied === null || supplied === undefined || supplied === '';
      if (!blank) {
        this.cache.set(symbol, supplied);
        this.trace.push({ kind: 'symbol', symbol, value: supplied, from: 'input' });
        return supplied;
      }
    }

    const variable = this.spec.variables.find((v) => v.symbol === symbol);
    if (variable) {
      if (variable.role === 'constant') {
        const value = (variable.value ?? null) as EvalValue;
        this.cache.set(symbol, value);
        this.trace.push({ kind: 'symbol', symbol, value, from: 'constant' });
        return value;
      }
      if (variable.role === 'derived') {
        this.resolving.add(symbol);
        try {
          const value = evalExpression(variable.expression!, this.resolver);
          this.cache.set(symbol, value);
          this.trace.push({
            kind: 'symbol',
            symbol,
            value: value as FormulaValue,
            from: 'derived',
            expression: variable.expression,
          });
          return value;
        } finally {
          this.resolving.delete(symbol);
        }
      }
      if (variable.role === 'input') {
        if (variable.value !== undefined) {
          const value = variable.value as EvalValue;
          this.cache.set(symbol, value);
          this.trace.push({ kind: 'symbol', symbol, value, from: 'default' });
          return value;
        }
        throw new SpecError(`missing required input '${symbol}'${unitHint(variable.unit)}`);
      }
      // role 'output' falls through to chaining below.
    }

    const producedBy = this.producers.get(symbol) ?? [];
    if (producedBy.length === 1) {
      this.resolving.add(symbol);
      try {
        const value = this.evalTarget(producedBy[0]!);
        this.cache.set(symbol, value as EvalValue);
        this.trace.push({ kind: 'symbol', symbol, value, from: 'produced' });
        return value as EvalValue;
      } finally {
        this.resolving.delete(symbol);
      }
    }
    if (producedBy.length > 1) {
      throw new SpecError(
        `'${symbol}' is produced by more than one target (${producedBy.join(', ')}); ` +
          `supply it as an input to say which`,
      );
    }
    throw new SpecError(`unknown symbol '${symbol}'`);
  }

  evalTarget(id: string): FormulaValue {
    // Targets recurse by id (a piecewise case names another target), but
    // `resolving` only tracks SYMBOLS — so `p1 -> p1`, or a p1/p2 pair, blew
    // the stack and returned thousands of junk trace steps with an error that
    // said nothing useful. Guard the id edge with the same discipline.
    if (this.resolvingTargets.has(id)) {
      throw new SpecError(
        `circular reference resolving target '${id}' (via ${[...this.resolvingTargets].join(' → ')})`,
      );
    }
    this.resolvingTargets.add(id);
    try {
      return this.evalTargetInner(id);
    } finally {
      this.resolvingTargets.delete(id);
    }
  }

  private evalTargetInner(id: string): FormulaValue {
    const expression = this.spec.expressions.find((e) => e.id === id);
    if (expression) {
      const value = evalExpression(expression.expression, this.resolver) as FormulaValue;
      this.trace.push({
        kind: 'expression',
        id,
        expression: expression.expression,
        value,
        equation: expression.equation,
      });
      return value;
    }

    const piecewise = this.spec.piecewise.find((p) => p.id === id);
    if (piecewise) {
      for (const branch of piecewise.cases) {
        if (truthy(evalExpression(branch.when, this.resolver))) {
          this.trace.push({
            kind: 'branch',
            id,
            when: branch.when,
            chose: branch.use,
            label: branch.label,
          });
          return this.evalTarget(branch.use);
        }
      }
      if (piecewise.otherwise) {
        this.trace.push({ kind: 'branch', id, when: 'otherwise', chose: piecewise.otherwise });
        return this.evalTarget(piecewise.otherwise);
      }
      throw new SpecError(`no case matched in '${id}' and no otherwise branch is defined`);
    }

    const lookup = this.spec.lookups.find((l) => l.id === id);
    if (lookup) return this.evalLookup(lookup);

    throw new SpecError(`unknown target '${id}'`);
  }

  private evalLookup(lookup: SpecLookup): FormulaValue {
    const key: Record<string, FormulaValue> = {};
    for (const k of lookup.keys) key[k] = this.resolveSymbol(k) as FormulaValue;

    const row = lookup.rows.find((r) => lookup.keys.every((k) => r[k] === key[k]));
    if (!row) {
      if (lookup.onMiss === 'null') {
        this.trace.push({ kind: 'lookup', id: lookup.id, key, value: null });
        return null;
      }
      const shown = lookup.keys.map((k) => `${k}=${String(key[k])}`).join(', ');
      throw new SpecError(
        `no row in '${lookup.id}' for ${shown} — the source table does not specify this combination`,
      );
    }
    const value = row[lookup.result] ?? null;
    this.trace.push({ kind: 'lookup', id: lookup.id, key, value, row });
    return value;
  }
}

function unitHint(unit: string | null | undefined): string {
  return unit ? ` (${unit})` : '';
}

/**
 * Evaluate one target — an expression, a piecewise branch, or a lookup — by id.
 * Inputs are keyed by symbol and override anything the spec declares.
 */
export function evaluateSpec(
  spec: FormulaSpec,
  targetId: string,
  inputs: Record<string, FormulaValue> = {},
): EvalResult {
  const evaluator = new SpecEvaluator(spec, inputs);
  try {
    const value = evaluator.evalTarget(targetId);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return {
        ok: false,
        error: `'${targetId}' evaluated to ${String(value)} — check for a divide by zero or an out-of-domain SQRT/LN`,
        trace: evaluator.trace,
      };
    }
    return { ok: true, value, trace: evaluator.trace };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      trace: evaluator.trace,
    };
  }
}

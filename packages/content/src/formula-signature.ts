/**
 * The CALLING CONTRACT for a formula: per evaluable target, what it produces
 * and what a caller must supply to get it.
 *
 * `evaluateSpec` answers "what is the number". This answers the question that
 * comes first and that nothing previously answered: *what must I hand it?* An
 * agent had to read the whole spec and reason out the resolution ladder to
 * guess; a UI evaluator had to re-derive the field list ad hoc; the public
 * share calculator has no way to know at all. All three now read one shape.
 *
 * It is a STATIC MIRROR of `formula-eval.ts`'s resolution order — supplied
 * input → constant → declared default → derived expression → the unique target
 * declaring the symbol as its `resultSymbol`. A symbol is *required* exactly
 * when that ladder cannot reach a value without one being supplied. If the two
 * ever disagree the evaluator is right and this is the bug: it exists to
 * predict the evaluator, not to define anything.
 *
 * Two consequences of being static rather than a dry-run:
 *
 * 1. It sees EVERY branch. A dry-run with placeholder values would report the
 *    inputs of whichever piecewise case happened to match, and a form built
 *    from that would be missing fields the moment a pressure crossed a
 *    threshold. Both branches' needs are unioned; `branches` carries the
 *    per-case breakdown so a caller can still say which ones a given path
 *    actually costs.
 * 2. It cannot fail on arithmetic. No division by zero, no out-of-domain SQRT,
 *    no lookup miss — asking what a formula needs must never itself error.
 *
 * Pure, dependency-free, and NEVER PERSISTED — computed on read, like the
 * rendered text and for the same reason (docs/formulas.md §1): a stored second
 * description of a safety calculation is a copy that can drift from the spec
 * it describes.
 */
import { refsIn } from './table-formula';
import type {
  FormulaSpec,
  FormulaValue,
  SpecClassification,
  SpecExpression,
  SpecLookup,
  SpecPiecewise,
  SpecVariable,
} from './formula-spec';

export type SignatureInputKind = 'number' | 'enum';

export interface SignatureInput {
  symbol: string;
  name?: string;
  unit?: string | null;
  /** `enum` when the legal values are known — a lookup key, or a rating. */
  kind: SignatureInputKind;
  /** False when the spec declares a default the evaluator would fall back to. */
  required: boolean;
  /** The value used if nothing is supplied. Only set when `required` is false. */
  default?: FormulaValue;
  /** Legal values, for an `enum`. */
  domain?: FormulaValue[];
  /** Rating → the criterion prose from the source, so a picker can explain the
   *  choice rather than offering bare letters. */
  criteria?: Record<string, string>;
  /** Set when the spec never declares this symbol. Evaluation fails with
   *  `unknown symbol` unless it is supplied — a spec defect worth surfacing,
   *  not a normal input. */
  undeclared?: true;
  /** Why it must be supplied, when the reason is not simply "no default". */
  note?: string;
}

export interface SignatureBranch {
  label?: string;
  when: string;
  use: string;
  /** Symbols this case alone needs, so a caller can show the cost of a path. */
  inputs: string[];
}

export interface TargetSignature {
  id: string;
  kind: 'expression' | 'piecewise' | 'lookup';
  /** The symbol this target declares as its result, if any. */
  produces?: string;
  unit?: string;
  /** Equation number in the source standard. */
  equation?: string;
  /**
   * Every unverified equation this target's value depends on, itself included.
   * Rolled up rather than reported per-expression because the caller's question
   * is "may I rely on this number", and a piecewise branch carries no
   * `unverified` of its own while depending entirely on one that does.
   */
  unverified: Array<{ id: string; reason: string }>;
  inputs: SignatureInput[];
  /** Piecewise only. */
  branches?: SignatureBranch[];
}

/** Suffixes a classification id conventionally carries over its symbol —
 *  `detection-rating` describes `detection`. */
const RATING_SUFFIXES = ['rating', 'ratings', 'classification', 'class', 'level', 'grade'];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which classification describes this symbol, if any.
 *
 * Nothing in the spec LINKS a classification to a symbol — the schema has no
 * such field, and adding one would invalidate every spec already stored. The
 * link is by name, the way authors already write it: the API RP 581 model's
 * `detection-rating` rubric is the one that explains the `detection` lookup
 * key. So this matches on the normalised id with a trailing rating-ish word
 * removed, and additionally requires the classification to cover every value
 * actually in play.
 *
 * Deliberately tight, and ambiguity yields nothing. The wrong rubric attached
 * to a rating would put misleading prose in front of whoever picks the value —
 * and in that model `detection` and `isolation` share the domain `A|B|C`, so
 * matching on domain shape alone would confidently offer detection criteria
 * for the isolation field. A missing rubric costs a picker its help text;
 * never a number, since classifications take no part in arithmetic.
 */
function classificationFor(
  classifications: SpecClassification[],
  symbol: string,
  domain: FormulaValue[] | undefined,
): SpecClassification | undefined {
  const want = norm(symbol);
  if (!want) return undefined;
  const matches = classifications.filter((c) => {
    const id = norm(c.id ?? '');
    if (!id) return false;
    if (id === want) return true;
    return RATING_SUFFIXES.some(
      (suffix) =>
        id.length > suffix.length && id.endsWith(suffix) && id.slice(0, -suffix.length) === want,
    );
  });
  if (matches.length !== 1) return undefined;
  const found = matches[0]!;
  if (domain && !domain.every((v) => found.domain.includes(String(v)))) return undefined;
  return found;
}

/** The values a lookup key can take: the declared domain, else exactly the
 *  values its rows carry — which is the set that can actually match. */
function domainOfKey(lookup: SpecLookup, key: string): FormulaValue[] {
  const declared = lookup.domains?.[key];
  if (Array.isArray(declared) && declared.length > 0) return declared;
  const out: FormulaValue[] = [];
  const seen = new Set<string>();
  for (const row of lookup.rows ?? []) {
    const value = row?.[key];
    if (value === undefined) continue;
    const marker = `${typeof value}:${String(value)}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    out.push(value);
  }
  return out;
}

/** Never throws: a malformed expression that slipped past validation must not
 *  take down "what does this need". */
function safeRefs(expression: string | undefined): string[] {
  if (!expression) return [];
  try {
    return refsIn(expression);
  } catch {
    return [];
  }
}

type EnumContext = { domain: FormulaValue[] };

class SignatureWalker {
  private readonly variables = new Map<string, SpecVariable>();
  /** resultSymbol → ids of targets declaring it, mirroring the evaluator. */
  private readonly producers = new Map<string, string[]>();
  private readonly expressions = new Map<string, SpecExpression>();
  private readonly piecewise = new Map<string, SpecPiecewise>();
  private readonly lookups = new Map<string, SpecLookup>();
  private readonly classifications: SpecClassification[];

  constructor(private readonly spec: FormulaSpec) {
    for (const v of spec.variables ?? []) if (v?.symbol) this.variables.set(v.symbol, v);
    for (const e of spec.expressions ?? []) if (e?.id) this.expressions.set(e.id, e);
    for (const p of spec.piecewise ?? []) if (p?.id) this.piecewise.set(p.id, p);
    for (const l of spec.lookups ?? []) if (l?.id) this.lookups.set(l.id, l);
    this.classifications = (spec.classifications ?? []).filter(Boolean);

    const claim = (symbol: string | undefined, id: string) => {
      if (!symbol) return;
      this.producers.set(symbol, [...(this.producers.get(symbol) ?? []), id]);
    };
    for (const e of spec.expressions ?? []) claim(e?.resultSymbol, e?.id ?? '');
    for (const p of spec.piecewise ?? []) claim(p?.resultSymbol, p?.id ?? '');
    for (const l of spec.lookups ?? []) claim(l?.resultSymbol, l?.id ?? '');
  }

  targetIds(): string[] {
    return [...this.expressions.keys(), ...this.piecewise.keys(), ...this.lookups.keys()];
  }

  signatureFor(id: string): TargetSignature {
    const scope = new Scope();
    this.walkTarget(id, scope);

    const expression = this.expressions.get(id);
    const piecewise = this.piecewise.get(id);
    const lookup = this.lookups.get(id);
    const produces = expression?.resultSymbol ?? piecewise?.resultSymbol ?? lookup?.resultSymbol;
    // A piecewise or lookup carries no unit of its own, but the symbol it
    // produces usually does — that is the unit of the answer either way.
    const unit =
      expression?.unit ??
      (produces ? (this.variables.get(produces)?.unit ?? undefined) : undefined);

    const sig: TargetSignature = {
      id,
      kind: expression ? 'expression' : piecewise ? 'piecewise' : 'lookup',
      ...(produces ? { produces } : {}),
      ...(unit ? { unit } : {}),
      ...(expression?.equation ? { equation: expression.equation } : {}),
      unverified: scope.unverified,
      inputs: [...scope.inputs.values()],
    };

    if (piecewise) {
      sig.branches = (piecewise.cases ?? []).map((c) => {
        const branch = new Scope();
        for (const ref of safeRefs(c.when)) this.walkSymbol(ref, branch, undefined);
        this.walkTarget(c.use, branch);
        return {
          ...(c.label ? { label: c.label } : {}),
          when: c.when,
          use: c.use,
          inputs: [...branch.inputs.keys()],
        };
      });
    }
    return sig;
  }

  private walkTarget(id: string, scope: Scope): void {
    if (scope.targets.has(id)) return;
    scope.targets.add(id);

    const expression = this.expressions.get(id);
    if (expression) {
      if (expression.unverified) {
        scope.addUnverified(expression.id, expression.unverified);
      }
      for (const ref of safeRefs(expression.expression)) this.walkSymbol(ref, scope, undefined);
      return;
    }

    const piecewise = this.piecewise.get(id);
    if (piecewise) {
      for (const c of piecewise.cases ?? []) {
        for (const ref of safeRefs(c.when)) this.walkSymbol(ref, scope, undefined);
        this.walkTarget(c.use, scope);
      }
      if (piecewise.otherwise) this.walkTarget(piecewise.otherwise, scope);
      return;
    }

    const lookup = this.lookups.get(id);
    if (lookup) {
      for (const key of lookup.keys ?? []) {
        this.walkSymbol(key, scope, { domain: domainOfKey(lookup, key) });
      }
    }
    // An unknown id contributes nothing — `evaluateSpec` reports it, and a
    // signature that invented inputs for a target that does not exist would be
    // worse than an empty one.
  }

  /** The evaluator's `resolveSymbol` ladder, walked for requiredness. */
  private walkSymbol(symbol: string, scope: Scope, enumCtx: EnumContext | undefined): void {
    const already = scope.inputs.get(symbol);
    if (already) {
      // Reached again with better information: the same symbol can be plain
      // arithmetic in one expression and a lookup key in another.
      if (enumCtx) this.applyEnum(already, symbol, enumCtx);
      return;
    }
    // Also guards cycles — a derived symbol re-entering itself finds its own
    // mark and stops, where the evaluator raises `circular reference`.
    if (scope.symbols.has(symbol)) return;
    scope.symbols.add(symbol);

    const variable = this.variables.get(symbol);

    if (variable?.role === 'constant') return; // fixed by the spec
    if (variable?.role === 'derived') {
      for (const ref of safeRefs(variable.expression)) this.walkSymbol(ref, scope, undefined);
      return;
    }
    if (variable?.role === 'input') {
      const hasDefault = variable.value !== undefined && variable.value !== null;
      this.addInput(scope, symbol, variable, enumCtx, {
        required: !hasDefault,
        ...(hasDefault ? { default: variable.value as FormulaValue } : {}),
      });
      return;
    }

    // `output`, or a symbol the spec never declares: the evaluator falls
    // through to whatever target produces it.
    const producedBy = this.producers.get(symbol) ?? [];
    if (producedBy.length === 1) {
      this.walkTarget(producedBy[0]!, scope);
      return;
    }
    if (producedBy.length > 1) {
      this.addInput(scope, symbol, variable, enumCtx, {
        required: true,
        note: `produced by more than one target (${producedBy.join(', ')}) — supply it to say which`,
      });
      return;
    }
    this.addInput(scope, symbol, variable, enumCtx, {
      required: true,
      ...(variable ? {} : { undeclared: true as const }),
    });
  }

  private addInput(
    scope: Scope,
    symbol: string,
    variable: SpecVariable | undefined,
    enumCtx: EnumContext | undefined,
    extra: Partial<SignatureInput> & { required: boolean },
  ): void {
    const input: SignatureInput = {
      symbol,
      ...(variable?.name ? { name: variable.name } : {}),
      ...(variable?.unit ? { unit: variable.unit } : {}),
      kind: 'number',
      ...extra,
    };
    this.applyEnum(input, symbol, enumCtx);
    scope.inputs.set(symbol, input);
  }

  /**
   * Turn an input into an `enum` when its legal values are knowable — from the
   * lookup it keys, or from a classification named after it. Without this a
   * rating renders as a free-text box, and a case-typo becomes a runtime error
   * where it could have been an impossible one.
   */
  private applyEnum(input: SignatureInput, symbol: string, enumCtx: EnumContext | undefined): void {
    const domain = enumCtx?.domain?.length ? enumCtx.domain : undefined;
    const classification = classificationFor(this.classifications, symbol, domain);
    const values = domain ?? (classification ? [...classification.domain] : undefined);
    if (!values?.length) return;
    input.kind = 'enum';
    input.domain = values;
    if (classification) {
      const criteria: Record<string, string> = {};
      for (const value of values) {
        const text = classification.criteria?.[String(value)];
        if (text) criteria[String(value)] = text;
      }
      if (Object.keys(criteria).length > 0) input.criteria = criteria;
    }
  }
}

/** Per-target accumulation. Insertion order is source order, which is reading
 *  order — the order an author would list the inputs themselves. */
class Scope {
  readonly inputs = new Map<string, SignatureInput>();
  readonly symbols = new Set<string>();
  readonly targets = new Set<string>();
  readonly unverified: Array<{ id: string; reason: string }> = [];
  private readonly unverifiedIds = new Set<string>();

  addUnverified(id: string, reason: string): void {
    if (this.unverifiedIds.has(id)) return;
    this.unverifiedIds.add(id);
    this.unverified.push({ id, reason });
  }
}

/**
 * The calling contract for every evaluable target of a spec, in the order
 * `formula_get` lists them: expressions, then piecewise, then lookups.
 */
export function signatureOf(spec: FormulaSpec): TargetSignature[] {
  const walker = new SignatureWalker(spec);
  return walker.targetIds().map((id) => walker.signatureFor(id));
}

/** One target's contract, or undefined if the id is not evaluable. */
export function signatureForTarget(
  spec: FormulaSpec,
  targetId: string,
): TargetSignature | undefined {
  const walker = new SignatureWalker(spec);
  return walker.targetIds().includes(targetId) ? walker.signatureFor(targetId) : undefined;
}

/**
 * One target rendered as a call line — `vapor-sonic(Ps [lbf/in2 (abs)], MW,
 * Ts [R]) → Wn [lb/sec]`. Used by `formulaToText` so the embedding captures
 * what a formula can COMPUTE, not only what it says; "can it work out a
 * release rate from pressure and temperature?" is a question about the
 * signature, and until it was indexed nothing could answer it.
 */
export function signatureLine(sig: TargetSignature): string {
  const args = sig.inputs
    .map((i) => {
      const unit = i.unit ? ` [${i.unit}]` : '';
      const optional = i.required ? '' : '?';
      return `${i.symbol}${optional}${unit}`;
    })
    .join(', ');
  const produces = sig.produces ? ` → ${sig.produces}${sig.unit ? ` [${sig.unit}]` : ''}` : '';
  return `${sig.id}(${args})${produces}`;
}

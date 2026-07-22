/**
 * The formula spec: a declarative description of a calculation that came out of
 * a published standard, rather than a single expression string.
 *
 * A real engineering calculation is not one formula. Working from API RP 581
 * Part 3 §5.3 as the motivating case, one "release quantity" model contains all
 * four of these, and only the first is an expression:
 *
 *   expressions      scalar maths — the release-rate equations
 *   piecewise        a branch — sonic vs subsonic, on a pressure threshold
 *   lookups          keyed tables — a reduction factor per detection/isolation
 *                    rating, a leak duration per rating AND hole size
 *   classifications  prose rubrics mapping a described system to a rating.
 *                    Human (or model) judgment, NOT arithmetic.
 *
 * Two decisions worth defending, because both were tempting to do otherwise:
 *
 * 1. Lookup tables are stored as DATA ROWS, never as a nested IF() chain in an
 *    expression. These tables come from a standard that gets revised; a changed
 *    factor should be a one-line diff a reviewer can hold against the printed
 *    table, not a re-reading of a forty-term conditional. Storing them as rows
 *    is also what makes `checkLookupCoverage` possible, which is the only
 *    reason we can prove a table is total over its keys instead of hoping.
 *
 * 2. Classifications are INPUTS, not computations. The criteria text lives in
 *    the spec so that a rating can be justified by citing the clause it matched,
 *    but nothing here tries to infer a rating from prose.
 *
 * Deliberately dependency-free and pure (no zod, no YAML) so it runs unchanged
 * in tool handlers, the API and the browser. Callers hand `parseFormulaSpec` an
 * already-parsed object; where that object came from is their problem.
 */

export type FormulaValue = number | string | boolean | null;

export type VariableRole = 'constant' | 'input' | 'derived' | 'output';

export interface SpecVariable {
  symbol: string;
  name?: string;
  /** Free text. Carried for display and review; not machine-checked (yet). */
  unit?: string | null;
  role: VariableRole;
  /** Required for `constant`; optional default for `input`. */
  value?: number | string | boolean;
  /** Required for `derived` — an expression over other symbols. */
  expression?: string;
  note?: string;
}

export interface SpecExpression {
  id: string;
  expression: string;
  /** Equation number in the source standard, for citation. */
  equation?: string;
  /** Symbol this expression produces, enabling unambiguous chaining. */
  resultSymbol?: string;
  unit?: string;
  /**
   * DISPLAY ONLY, and never parsed. `expression` is the single source of truth
   * for what is computed; this is a parallel rendering for human eyes, so that
   * a spec can be shown the way it appears in the standard. Nothing verifies
   * the two agree — treat a mismatch as a documentation bug, and never reach
   * for this when you mean `expression`.
   */
  latex?: string;
  note?: string;
}

export interface SpecPiecewiseCase {
  /** Condition expression; the first truthy case wins. */
  when: string;
  /** Id of the expression to evaluate when this case matches. */
  use: string;
  label?: string;
}

export interface SpecPiecewise {
  id: string;
  cases: SpecPiecewiseCase[];
  /** Expression id used when no case matches. Absent means "that is an error". */
  otherwise?: string;
  resultSymbol?: string;
  note?: string;
}

export interface SpecLookup {
  id: string;
  name?: string;
  /** Variable symbols supplying the key, in no particular order. */
  keys: string[];
  /** The field on each row carrying the looked-up value. */
  result: string;
  rows: Array<Record<string, FormulaValue>>;
  /** Declared legal values per key. Enables `checkLookupCoverage`. */
  domains?: Record<string, FormulaValue[]>;
  /**
   * What an unmatched key means. Defaults to `error` — a missing row in a
   * safety calculation is a gap in the standard, not a zero.
   */
  onMiss?: 'error' | 'null';
  resultSymbol?: string;
}

export interface SpecClassification {
  id: string;
  domain: string[];
  /** Rating → the criterion text from the source, for justification. */
  criteria: Record<string, string>;
  note?: string;
}

export interface SpecSource {
  standard?: string;
  part?: string;
  sections?: string[];
  tables?: string[];
  edition?: string;
}

export interface FormulaSpec {
  id: string;
  name?: string;
  source?: SpecSource;
  unitSystem?: string;
  notes?: Record<string, string>;
  variables: SpecVariable[];
  expressions: SpecExpression[];
  piecewise: SpecPiecewise[];
  lookups: SpecLookup[];
  classifications: SpecClassification[];
}

export type ParseResult =
  | { ok: true; spec: FormulaSpec }
  | { ok: false; errors: string[] };

const ROLES: VariableRole[] = ['constant', 'input', 'derived', 'output'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Validate an already-parsed object into a FormulaSpec. Returns every problem
 * found rather than throwing on the first, because these specs get transcribed
 * from printed standards by hand and a reviewer wants the whole list.
 */
export function parseFormulaSpec(input: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['spec must be an object'] };

  const id = str(input.id);
  if (!id) errors.push('spec.id is required');

  const variables: SpecVariable[] = [];
  const seenSymbols = new Set<string>();
  for (const [i, raw] of asArray(input.variables).entries()) {
    const at = `variables[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const symbol = str(raw.symbol);
    const role = str(raw.role) as VariableRole | undefined;
    if (!symbol) {
      errors.push(`${at}.symbol is required`);
      continue;
    }
    if (seenSymbols.has(symbol)) errors.push(`${at}: duplicate symbol '${symbol}'`);
    seenSymbols.add(symbol);
    if (!role || !ROLES.includes(role)) {
      errors.push(`${at} '${symbol}': role must be one of ${ROLES.join(', ')}`);
      continue;
    }
    const expression = str(raw.expression);
    const hasValue = raw.value !== undefined && raw.value !== null;
    if (role === 'constant' && !hasValue) {
      errors.push(`${at} '${symbol}': a constant needs a value`);
    }
    if (role === 'derived' && !expression) {
      errors.push(`${at} '${symbol}': a derived variable needs an expression`);
    }
    variables.push({
      symbol,
      name: str(raw.name),
      unit: typeof raw.unit === 'string' ? raw.unit : null,
      role,
      value: hasValue ? (raw.value as number | string | boolean) : undefined,
      expression,
      note: str(raw.note),
    });
  }

  // Expressions, piecewise and lookups share one id namespace: a piecewise case
  // and an evaluation target both address them by bare id.
  const ids = new Set<string>();
  const claimId = (candidate: string | undefined, at: string): string => {
    if (!candidate) {
      errors.push(`${at}.id is required`);
      return '';
    }
    if (ids.has(candidate)) errors.push(`${at}: duplicate id '${candidate}'`);
    ids.add(candidate);
    return candidate;
  };

  const expressions: SpecExpression[] = [];
  for (const [i, raw] of asArray(input.expressions).entries()) {
    const at = `expressions[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const exprId = claimId(str(raw.id), at);
    const expression = str(raw.expression);
    if (!expression) errors.push(`${at} '${exprId}': expression is required`);
    expressions.push({
      id: exprId,
      expression: expression ?? '',
      equation: str(raw.equation),
      resultSymbol: str(raw.resultSymbol),
      unit: str(raw.unit),
      latex: str(raw.latex),
      note: str(raw.note),
    });
  }

  const piecewise: SpecPiecewise[] = [];
  for (const [i, raw] of asArray(input.piecewise).entries()) {
    const at = `piecewise[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const pwId = claimId(str(raw.id), at);
    const cases: SpecPiecewiseCase[] = [];
    for (const [j, rawCase] of asArray(raw.cases).entries()) {
      if (!isObj(rawCase)) {
        errors.push(`${at}.cases[${j}] must be an object`);
        continue;
      }
      const when = str(rawCase.when);
      const use = str(rawCase.use);
      if (!when) errors.push(`${at}.cases[${j}]: when is required`);
      if (!use) errors.push(`${at}.cases[${j}]: use is required`);
      if (when && use) cases.push({ when, use, label: str(rawCase.label) });
    }
    if (cases.length === 0) errors.push(`${at} '${pwId}': needs at least one case`);
    piecewise.push({
      id: pwId,
      cases,
      otherwise: str(raw.otherwise),
      resultSymbol: str(raw.resultSymbol),
      note: str(raw.note),
    });
  }

  const lookups: SpecLookup[] = [];
  for (const [i, raw] of asArray(input.lookups).entries()) {
    const at = `lookups[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const lkId = claimId(str(raw.id), at);
    const keys = asArray(raw.keys).filter((k): k is string => typeof k === 'string');
    const result = str(raw.result);
    if (keys.length === 0) errors.push(`${at} '${lkId}': needs at least one key`);
    if (!result) errors.push(`${at} '${lkId}': result field name is required`);
    const rows: Array<Record<string, FormulaValue>> = [];
    for (const [j, rawRow] of asArray(raw.rows).entries()) {
      if (!isObj(rawRow)) {
        errors.push(`${at}.rows[${j}] must be an object`);
        continue;
      }
      for (const key of keys) {
        if (rawRow[key] === undefined) errors.push(`${at}.rows[${j}] is missing key '${key}'`);
      }
      if (result && rawRow[result] === undefined) {
        errors.push(`${at}.rows[${j}] is missing result '${result}'`);
      }
      rows.push(rawRow as Record<string, FormulaValue>);
    }
    if (rows.length === 0) errors.push(`${at} '${lkId}': needs at least one row`);
    const onMiss = str(raw.onMiss);
    if (onMiss && onMiss !== 'error' && onMiss !== 'null') {
      errors.push(`${at} '${lkId}': onMiss must be 'error' or 'null'`);
    }
    lookups.push({
      id: lkId,
      name: str(raw.name),
      keys,
      result: result ?? '',
      rows,
      domains: isObj(raw.domains) ? (raw.domains as Record<string, FormulaValue[]>) : undefined,
      onMiss: onMiss === 'null' ? 'null' : 'error',
      resultSymbol: str(raw.resultSymbol),
    });
  }

  const classifications: SpecClassification[] = [];
  for (const [i, raw] of asArray(input.classifications).entries()) {
    const at = `classifications[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const clId = claimId(str(raw.id), at);
    const domain = asArray(raw.domain).filter((d): d is string => typeof d === 'string');
    if (domain.length === 0) errors.push(`${at} '${clId}': domain is required`);
    const criteria = isObj(raw.criteria) ? (raw.criteria as Record<string, string>) : {};
    for (const value of domain) {
      if (!criteria[value]) errors.push(`${at} '${clId}': no criterion for '${value}'`);
    }
    classifications.push({ id: clId, domain, criteria, note: str(raw.note) });
  }

  // Cross-references resolve only once every id is known.
  for (const pw of piecewise) {
    for (const c of pw.cases) {
      if (!ids.has(c.use)) errors.push(`piecewise '${pw.id}': case uses unknown id '${c.use}'`);
    }
    if (pw.otherwise && !ids.has(pw.otherwise)) {
      errors.push(`piecewise '${pw.id}': otherwise uses unknown id '${pw.otherwise}'`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      id: id!,
      name: str(input.name),
      source: isObj(input.source) ? (input.source as SpecSource) : undefined,
      unitSystem: str(input.unitSystem),
      notes: isObj(input.notes) ? (input.notes as Record<string, string>) : undefined,
      variables,
      expressions,
      piecewise,
      lookups,
      classifications,
    },
  };
}

export interface CoverageGap {
  lookupId: string;
  /** A key combination in the declared domains with no matching row. */
  key: Record<string, FormulaValue>;
}

/**
 * Report key combinations a lookup declares as legal but has no row for.
 *
 * This is the payoff for storing tables as data. API RP 581 Table 5.6 specifies
 * six of the nine detection/isolation combinations; the other three are simply
 * absent from the printed table. Encoded as a nested IF() that gap is invisible
 * until it silently yields a zero adjustment on a live assessment. Encoded as
 * rows with declared domains, it is a list you can put in front of an engineer.
 *
 * Not an error — an incomplete table is a fact about the source, not a
 * malformed spec — so this is reported separately from `parseFormulaSpec`.
 */
export function checkLookupCoverage(spec: FormulaSpec): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const lookup of spec.lookups) {
    if (!lookup.domains) continue;
    const keys = lookup.keys.filter((k) => lookup.domains?.[k]?.length);
    if (keys.length !== lookup.keys.length) continue; // partial domains: can't be exhaustive
    let combos: Array<Record<string, FormulaValue>> = [{}];
    for (const key of keys) {
      const values = lookup.domains[key]!;
      combos = combos.flatMap((base) => values.map((v) => ({ ...base, [key]: v })));
    }
    for (const combo of combos) {
      const hit = lookup.rows.some((row) => keys.every((k) => row[k] === combo[k]));
      if (!hit) gaps.push({ lookupId: lookup.id, key: combo });
    }
  }
  return gaps;
}

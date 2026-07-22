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

import { evalExpression } from './table-formula';

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
  /**
   * Set when the equation was NOT read off the source — supplied from memory,
   * inferred, or reconstructed. It renders as a warning wherever the equation
   * is shown or indexed, so a from-memory citation can never be mistaken for a
   * transcribed one. The first cut carried this as an ad-hoc `derivedNotInSource`
   * key, which the parser silently dropped — so the caveat vanished while the
   * fabricated equation number went into the embedding as fact.
   */
  unverified?: string;
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

/** A cell a lookup row may carry. Anything else (object, array, function,
 *  NaN) is rejected: it would flow out of `evaluateSpec` as the result and
 *  `toNum` would quietly turn it into 0. */
function isScalar(v: unknown): v is FormulaValue {
  if (v === null) return true;
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Is this a syntactically valid expression? The validator used to check only
 * that the string was non-empty, so a spec of pure punctuation validated
 * clean and failed at evaluation time with no id context. Parsing here is
 * what makes `parseFormulaSpec`'s "every problem found" claim true.
 */
function syntaxError(src: string): string | null {
  try {
    evalExpression(src, () => null);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}


/** Declared legal values per key. Rejects a non-array (a string has `.length`
 *  too, which used to reach `.map` and throw), non-scalar entries, and a key
 *  the lookup does not actually have. */
function parseDomains(
  raw: unknown,
  keys: string[],
  at: string,
  errors: string[],
): Record<string, FormulaValue[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    errors.push(`${at}.domains must be an object`);
    return undefined;
  }
  const out: Record<string, FormulaValue[]> = {};
  for (const [key, values] of Object.entries(raw)) {
    if (!keys.includes(key)) {
      errors.push(`${at}.domains names '${key}', which is not one of the lookup's keys`);
      continue;
    }
    if (!Array.isArray(values)) {
      errors.push(`${at}.domains['${key}'] must be an array`);
      continue;
    }
    if (!values.every(isScalar)) {
      errors.push(`${at}.domains['${key}'] may only contain numbers, strings, booleans or null`);
      continue;
    }
    out[key] = values as FormulaValue[];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `sections`/`tables` reached `.join` unvalidated, so `sections: '5.3'`
 *  validated clean and then threw inside `formulaToText` — hard-failing the
 *  extractor's ingest path for an otherwise-loadable spec. */
function parseSource(raw: unknown, errors: string[]): SpecSource | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    errors.push('spec.source must be an object');
    return undefined;
  }
  const strList = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      errors.push(`spec.source.${field} must be an array of strings`);
      return undefined;
    }
    return v as string[];
  };
  return {
    standard: str(raw.standard),
    part: str(raw.part),
    edition: str(raw.edition),
    sections: strList(raw.sections, 'sections'),
    tables: strList(raw.tables, 'tables'),
  };
}

/** Notes are free prose keyed by topic; anything non-string is dropped rather
 *  than rendered as `[object Object]` into the indexed text. */
function parseNotes(raw: unknown): Record<string, string> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const text = str(value);
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate an already-parsed object into a FormulaSpec. Returns every problem
 * found rather than throwing on the first, because these specs get transcribed
 * from printed standards by hand and a reviewer wants the whole list.
 */
export function parseFormulaSpec(input: unknown): ParseResult {
  const errors: string[] = [];
  /** A non-array where a list belongs used to be silently coerced to [], so a
   *  spec with `expressions: 'oops'` validated clean AND EMPTY. Report it. */
  const asArray = (v: unknown, at: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      errors.push(`${at} must be an array`);
      return [];
    }
    return v;
  };
  if (!isObj(input)) return { ok: false, errors: ['spec must be an object'] };

  const id = str(input.id);
  if (!id) errors.push('spec.id is required');

  const variables: SpecVariable[] = [];
  const seenSymbols = new Set<string>();
  for (const [i, raw] of asArray(input.variables, 'variables').entries()) {
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
    if (expression) {
      const bad = syntaxError(expression);
      if (bad) errors.push(`${at} '${symbol}': expression does not parse — ${bad}`);
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
  for (const [i, raw] of asArray(input.expressions, 'expressions').entries()) {
    const at = `expressions[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const exprId = claimId(str(raw.id), at);
    const expression = str(raw.expression);
    if (!expression) errors.push(`${at} '${exprId}': expression is required`);
    else {
      const bad = syntaxError(expression);
      if (bad) errors.push(`${at} '${exprId}': expression does not parse — ${bad}`);
    }
    expressions.push({
      id: exprId,
      expression: expression ?? '',
      equation: str(raw.equation),
      resultSymbol: str(raw.resultSymbol),
      unit: str(raw.unit),
      latex: str(raw.latex),
      unverified: str(raw.unverified),
      note: str(raw.note),
    });
  }

  const piecewise: SpecPiecewise[] = [];
  for (const [i, raw] of asArray(input.piecewise, 'piecewise').entries()) {
    const at = `piecewise[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const pwId = claimId(str(raw.id), at);
    const cases: SpecPiecewiseCase[] = [];
    for (const [j, rawCase] of asArray(raw.cases, `${at}.cases`).entries()) {
      if (!isObj(rawCase)) {
        errors.push(`${at}.cases[${j}] must be an object`);
        continue;
      }
      const when = str(rawCase.when);
      const use = str(rawCase.use);
      if (!when) errors.push(`${at}.cases[${j}]: when is required`);
      else {
        const bad = syntaxError(when);
        if (bad) errors.push(`${at}.cases[${j}]: when does not parse — ${bad}`);
      }
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
  for (const [i, raw] of asArray(input.lookups, 'lookups').entries()) {
    const at = `lookups[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const lkId = claimId(str(raw.id), at);
    const keys = asArray(raw.keys, `${at}.keys`).filter((k): k is string => typeof k === 'string');
    const result = str(raw.result);
    if (keys.length === 0) errors.push(`${at} '${lkId}': needs at least one key`);
    if (!result) errors.push(`${at} '${lkId}': result field name is required`);
    const rows: Array<Record<string, FormulaValue>> = [];
    for (const [j, rawRow] of asArray(raw.rows, `${at}.rows`).entries()) {
      if (!isObj(rawRow)) {
        errors.push(`${at}.rows[${j}] must be an object`);
        continue;
      }
      // Object.hasOwn, not `!== undefined`: a field named `toString` or
      // `constructor` inherits from the prototype, so the loose check passed
      // and a FUNCTION flowed out as the looked-up value.
      for (const key of keys) {
        if (!Object.hasOwn(rawRow, key)) {
          errors.push(`${at}.rows[${j}] is missing key '${key}'`);
        } else if (!isScalar(rawRow[key])) {
          errors.push(`${at}.rows[${j}] key '${key}' must be a number, string, boolean or null`);
        }
      }
      if (result) {
        if (!Object.hasOwn(rawRow, result)) {
          errors.push(`${at}.rows[${j}] is missing result '${result}'`);
        } else if (!isScalar(rawRow[result])) {
          // Without this, `fact_di: {"value": 0.25}` validated clean and then
          // read as 0 in arithmetic — a silent zero adjustment.
          errors.push(`${at}.rows[${j}] result '${result}' must be a number, string, boolean or null`);
        }
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
      domains: parseDomains(raw.domains, keys, at, errors),
      onMiss: onMiss === 'null' ? 'null' : 'error',
      resultSymbol: str(raw.resultSymbol),
    });
  }

  const classifications: SpecClassification[] = [];
  for (const [i, raw] of asArray(input.classifications, 'classifications').entries()) {
    const at = `classifications[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const clId = claimId(str(raw.id), at);
    const domain = asArray(raw.domain, `${at}.domain`).filter((d): d is string => typeof d === 'string');
    if (domain.length === 0) errors.push(`${at} '${clId}': domain is required`);
    const criteria = isObj(raw.criteria) ? (raw.criteria as Record<string, string>) : {};
    for (const value of domain) {
      // Own-property again: a domain entry of 'toString' would otherwise find
      // an inherited function and render it into the indexed text.
      if (!Object.hasOwn(criteria, value) || !str(criteria[value])) {
        errors.push(`${at} '${clId}': no criterion for '${value}'`);
      }
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

  const source = parseSource(input.source, errors);
  const notes = parseNotes(input.notes);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      id: id!,
      name: str(input.name),
      source,
      unitSystem: str(input.unitSystem),
      notes,
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
  /** Set instead of `key` when the table was too large to check — a silent
   *  "no gaps" on an unchecked table would be a lie. */
  skipped?: string;
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
/**
 * Ceiling on the cartesian product a single lookup may expand to.
 *
 * Without it this function is a remote kill switch: `domains` of 6 keys × 20
 * values is 64M combinations, each materialised as an object, and Node dies
 * with an OOM that NO caller can catch. Coverage runs on every read of every
 * formula, so one stored spec would brick the brain permanently. Real tables
 * are tens of rows; anything past this is a malformed or hostile spec.
 */
const MAX_COVERAGE_COMBINATIONS = 10_000;

export function checkLookupCoverage(spec: FormulaSpec): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const lookup of spec.lookups ?? []) {
    if (!lookup.domains) continue;
    const keys = lookup.keys.filter((k) => Array.isArray(lookup.domains?.[k]) && lookup.domains[k]!.length > 0);
    if (keys.length !== lookup.keys.length) continue; // partial domains: can't be exhaustive

    // Size the product BEFORE building it.
    let total = 1;
    for (const key of keys) total *= lookup.domains[key]!.length;
    if (total > MAX_COVERAGE_COMBINATIONS) {
      gaps.push({
        lookupId: lookup.id,
        key: {},
        skipped: `declares ${total} key combinations, above the ${MAX_COVERAGE_COMBINATIONS} coverage limit — not checked`,
      });
      continue;
    }

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

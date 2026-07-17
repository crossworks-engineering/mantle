/**
 * Central coerce-then-validate for tool-call arguments.
 *
 * The JSON Schema on every tool row is sent to the model as guidance, but
 * historically nothing checked the model's args against it before dispatch —
 * each handler hand-coerced (`str()`/`num()`) and silently defaulted, so a
 * mistyped argument became a *successful wrong call* instead of a corrective
 * error. This module closes that gap in two passes:
 *
 *   1. COERCE — repair the harmless drift models actually emit, so a call
 *      that's semantically right doesn't fail on encoding trivia:
 *        · "42"            → 42        (expected number/integer)
 *        · "true"/"false"  → boolean   (expected boolean)
 *        · 42 / true       → "42"      (expected string)
 *        · bare scalar     → [scalar]  (expected array)
 *        · '{"a":1}'       → object    (expected object/array, JSON-parses)
 *        · null            → key dropped (param not required)
 *      Every repair is recorded so the trace shows drift rates per tool.
 *
 *   2. VALIDATE — what survives coercion is checked against the schema
 *      subset our tools actually use (type, required, enum, minimum/maximum,
 *      minLength/maxLength, items.type, additionalProperties). Violations
 *      produce TEACHING errors: they name the field, what was expected, what
 *      arrived, and — for enum near-misses and unknown keys — the closest
 *      valid alternative, so the model can self-correct in one retry.
 *
 * Deliberately NOT here:
 *   · `default` injection — handlers already default; doing it twice would
 *     hide handler bugs behind the validator.
 *   · unknown-key REJECTION when the schema doesn't opt in — several tools
 *     (table_row_add cells, api tools with open schemas) take dynamic keys.
 *     Unknown keys are always *reported* for telemetry; they only become
 *     violations when the schema explicitly sets `additionalProperties: false`.
 *
 * Pure and dependency-free so vitest locks it down without DB or runtime.
 * The enforcement MODE (off/warn/enforce) is the caller's concern — this
 * module just reports; the tool-loop decides whether to block.
 */

export type ArgRepair = {
  key: string;
  kind: 'number' | 'boolean' | 'string' | 'array-wrap' | 'json-parse' | 'null-drop';
  /** Compact before→after note for trace meta, e.g. `"42" → 42`. */
  note: string;
};

export type ArgViolation = {
  key: string;
  /** Teaching text: what's wrong AND what to do instead. */
  message: string;
};

export type UnknownKey = {
  key: string;
  /** Closest declared property name, when it's a confident near-miss. */
  suggestion: string | null;
};

export type ValidateArgsResult = {
  /** Args with safe repairs applied (input object is never mutated). */
  input: Record<string, unknown>;
  repairs: ArgRepair[];
  violations: ArgViolation[];
  unknownKeys: UnknownKey[];
  /** Composed teaching error when violations exist (or unknown keys on a
   *  closed schema), ready to hand to the model verbatim. Null when the
   *  call is dispatchable as-is. */
  error: string | null;
};

type PropSchema = Record<string, unknown>;

/** The `type` values we understand. Anything else (or a missing type) is
 *  passed through unvalidated — fail open, never invent constraints. */
type KnownType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

const KNOWN_TYPES = new Set<string>(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export function validateToolArgs(
  schema: Record<string, unknown> | null | undefined,
  rawInput: Record<string, unknown>,
  toolSlug: string,
): ValidateArgsResult {
  const passthrough: ValidateArgsResult = {
    input: rawInput,
    repairs: [],
    violations: [],
    unknownKeys: [],
    error: null,
  };
  if (!schema || typeof schema !== 'object') return passthrough;
  const properties = asRecord(schema.properties);
  if (!properties || Object.keys(properties).length === 0) return passthrough;

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [],
  );
  const closedSchema = schema.additionalProperties === false;
  const declaredKeys = Object.keys(properties);

  const repairs: ArgRepair[] = [];
  const violations: ArgViolation[] = [];
  const unknownKeys: UnknownKey[] = [];
  const input: Record<string, unknown> = { ...rawInput };

  // ── Unknown keys ──
  for (const key of Object.keys(rawInput)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
    const suggestion = closestMatch(key, declaredKeys);
    unknownKeys.push({ key, suggestion });
    if (closedSchema) {
      violations.push({
        key,
        message:
          `'${key}' is not a parameter of this tool` +
          (suggestion ? ` — did you mean '${suggestion}'?` : '') +
          ` (declared parameters: ${declaredKeys.join(', ')})`,
      });
    }
  }

  // ── Per-property coerce, then validate ──
  for (const [key, propRaw] of Object.entries(properties)) {
    const prop = asRecord(propRaw);
    if (!prop) continue;
    const expected = expectedTypes(prop);
    const present = Object.prototype.hasOwnProperty.call(input, key);

    if (!present || input[key] === undefined) {
      if (required.has(key)) {
        violations.push({ key, message: requiredMessage(key, prop) });
      }
      continue;
    }

    // null: an optional param explicitly nulled is the model saying "unset" —
    // drop the key so handlers see it as absent. A required param nulled is a
    // violation (null never satisfies a required string/number/… here).
    if (input[key] === null) {
      if (required.has(key)) {
        violations.push({ key, message: requiredMessage(key, prop) });
      } else {
        delete input[key];
        repairs.push({ key, kind: 'null-drop', note: 'null → (omitted)' });
      }
      continue;
    }

    if (expected.length === 0) continue; // no/unknown type declared — fail open

    // Coercion pass: try to repair toward the first expected type the value
    // doesn't already satisfy. If the value already matches ANY expected
    // type, leave it alone.
    if (!expected.some((t) => matchesType(input[key], t))) {
      const repaired = coerceValue(input[key], expected);
      if (repaired) {
        repairs.push({ key, kind: repaired.kind, note: repaired.note });
        input[key] = repaired.value;
      }
    }

    const value = input[key];
    if (!expected.some((t) => matchesType(value, t))) {
      // Special-case the commonest near-miss: a fractional number where an
      // integer is declared. The generic "wrong type" text would be
      // technically true but unhelpful — say exactly what to do.
      const fractionalForInteger =
        expected.includes('integer') && typeof value === 'number' && Number.isFinite(value);
      violations.push({
        key,
        message: fractionalForInteger
          ? `'${key}' must be an integer (got ${value}) — round it and re-issue`
          : `'${key}' must be ${typeList(expected)} (got ${describeValue(value)})`,
      });
      continue; // constraint checks below assume the right shape
    }

    // Enum (string enums are the only kind our schemas use).
    const enumValues = Array.isArray(prop.enum)
      ? prop.enum.filter((v): v is string => typeof v === 'string')
      : null;
    if (
      enumValues &&
      enumValues.length > 0 &&
      typeof value === 'string' &&
      !enumValues.includes(value)
    ) {
      const suggestion = closestMatch(value, enumValues);
      violations.push({
        key,
        message:
          `'${key}' must be one of: ${enumValues.join(', ')} (got '${value}')` +
          (suggestion ? ` — did you mean '${suggestion}'?` : ''),
      });
      continue;
    }

    // Numeric range.
    if (typeof value === 'number') {
      const min = typeof prop.minimum === 'number' ? prop.minimum : null;
      const max = typeof prop.maximum === 'number' ? prop.maximum : null;
      if ((min !== null && value < min) || (max !== null && value > max)) {
        const range =
          min !== null && max !== null
            ? `between ${min} and ${max}`
            : min !== null
              ? `at least ${min}`
              : `at most ${max}`;
        violations.push({
          key,
          message: `'${key}' must be ${range} (got ${value})`,
        });
        continue;
      }
    }

    // String length.
    if (typeof value === 'string') {
      const minLen = typeof prop.minLength === 'number' ? prop.minLength : null;
      const maxLen = typeof prop.maxLength === 'number' ? prop.maxLength : null;
      if (minLen !== null && value.length < minLen) {
        violations.push({
          key,
          message: `'${key}' must be at least ${minLen} characters (got ${value.length})`,
        });
        continue;
      }
      if (maxLen !== null && value.length > maxLen) {
        violations.push({
          key,
          message: `'${key}' must be at most ${maxLen} characters (got ${value.length}) — shorten it`,
        });
        continue;
      }
    }

    // Array element type (validate only — element-level coercion would be
    // guessing at intent; a mixed array is worth a corrective round-trip).
    if (Array.isArray(value)) {
      const items = asRecord(prop.items);
      const itemType =
        items && typeof items.type === 'string' && KNOWN_TYPES.has(items.type)
          ? (items.type as KnownType)
          : null;
      if (itemType) {
        const badIndex = value.findIndex((el) => !matchesType(el, itemType));
        if (badIndex !== -1) {
          violations.push({
            key,
            message:
              `'${key}' must be an array of ${itemType}s — element ${badIndex} is ` +
              `${describeValue(value[badIndex])}`,
          });
          continue;
        }
      }
    }
  }

  const error =
    violations.length > 0
      ? `invalid arguments for '${toolSlug}': ` +
        violations.map((v) => v.message).join('; ') +
        `. Fix the argument${violations.length > 1 ? 's' : ''} and re-issue the call — ` +
        `do not retry with the same arguments.`
      : null;

  return { input, repairs, violations, unknownKeys, error };
}

// ── Coercion ──

type Coerced = { value: unknown; kind: ArgRepair['kind']; note: string } | null;

/** Attempt ONE safe repair toward any of the expected types. Conservative by
 *  design: only transformations that cannot change the model's intent. */
function coerceValue(value: unknown, expected: KnownType[]): Coerced {
  // Stringified JSON for structured params: '{"a":1}' → object, '[1,2]' → array.
  if (typeof value === 'string' && (expected.includes('object') || expected.includes('array'))) {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (expected.includes('object') && matchesType(parsed, 'object')) {
          return { value: parsed, kind: 'json-parse', note: 'JSON string → object' };
        }
        if (expected.includes('array') && Array.isArray(parsed)) {
          return { value: parsed, kind: 'json-parse', note: 'JSON string → array' };
        }
      } catch {
        /* fall through to other repairs / validation */
      }
    }
  }
  // "42" → 42.
  if (typeof value === 'string' && (expected.includes('number') || expected.includes('integer'))) {
    const trimmed = value.trim();
    if (trimmed !== '' && /^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        return { value: n, kind: 'number', note: `"${trimmed}" → ${n}` };
      }
    }
  }
  // "true"/"false" → boolean.
  if (typeof value === 'string' && expected.includes('boolean')) {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === 'false') {
      return { value: lower === 'true', kind: 'boolean', note: `"${value}" → ${lower}` };
    }
  }
  // 42 / true → "42" — harmless in the string direction (ids, queries).
  if ((typeof value === 'number' || typeof value === 'boolean') && expected.includes('string')) {
    return { value: String(value), kind: 'string', note: `${String(value)} → "${String(value)}"` };
  }
  // Bare scalar where an array is expected → wrap. (Common open-model drift:
  // `tags: "urgent"` for `tags: ["urgent"]`.)
  if (
    expected.includes('array') &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
  ) {
    return { value: [value], kind: 'array-wrap', note: `scalar → [scalar]` };
  }
  return null;
}

// ── Helpers ──

function expectedTypes(prop: PropSchema): KnownType[] {
  const t = prop.type;
  if (typeof t === 'string') return KNOWN_TYPES.has(t) ? [t as KnownType] : [];
  if (Array.isArray(t)) {
    return t.filter((x): x is KnownType => typeof x === 'string' && KNOWN_TYPES.has(x));
  }
  return [];
}

function matchesType(value: unknown, t: KnownType): boolean {
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

function requiredMessage(key: string, prop: PropSchema): string {
  const desc =
    typeof prop.description === 'string' && prop.description.trim() !== ''
      ? ` — ${truncate(prop.description.trim(), 120)}`
      : '';
  return `'${key}' is required${desc}`;
}

function typeList(expected: KnownType[]): string {
  const names = expected.map((t) =>
    t === 'integer'
      ? 'an integer'
      : t === 'array'
        ? 'an array'
        : t === 'object'
          ? 'an object'
          : `a ${t}`,
  );
  return names.join(' or ');
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  switch (typeof value) {
    case 'string':
      return `string "${truncate(value, 60)}"`;
    case 'object':
      return 'an object';
    default:
      return `${typeof value} ${truncate(String(value), 60)}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pick the candidate the caller most likely intended, or null when nothing is
 * a confident match. Same conservative contract as invoke_agent's delegate
 * suggestion: at most ONE result, and only on a strong signal — containment
 * ('page' ⊂ 'page_id') or a small edit distance relative to length (typos).
 * Exported for reuse anywhere a near-miss hint helps the model self-correct.
 */
export function closestMatch(target: string, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const t = target.toLowerCase();

  const contained = candidates
    .filter((s) => {
      const x = s.toLowerCase();
      return x !== t && (x.includes(t) || t.includes(x));
    })
    .sort((a, b) => b.length - a.length);
  const top = contained[0];
  if (top) return top;

  let best: string | null = null;
  let bestDist = Infinity;
  for (const s of candidates) {
    const d = levenshtein(t, s.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  const threshold = Math.max(2, Math.floor(t.length / 3));
  return best !== null && bestDist <= threshold ? best : null;
}

/** Iterative Levenshtein edit distance — small, dependency-free, two-row. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

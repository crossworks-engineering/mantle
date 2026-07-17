/**
 * Pure parser + validators for the extractor's LLM response.
 *
 * Lives in its own module so vitest can exercise the parsing logic
 * without booting the rest of extractor.ts (DB, OpenRouter client,
 * embedder). All side-effect-free except for the `console.error` we
 * emit on a parse failure — distinct log line so silent prompt drift
 * shows up in journalctl.
 */

export type ExtractedFact = {
  content: string;
  kind: 'factual' | 'episodic' | 'semantic' | 'preference';
  confidence: number;
  entities?: { name: string; kind: string }[];
  /** ISO date (YYYY-MM-DD) the event happened — episodic facts only, when the
   *  content states a specific date. Drives `valid_from` (and thus recency), so
   *  an episode from 2 years ago decays by when it HAPPENED, not when ingested. */
  occurredAt?: string;
};

/** Accept a strict YYYY-MM-DD (optionally with a time suffix we ignore) within a
 *  sane year range; reject relative/garbage dates. Returns the date string or
 *  undefined. */
export function parseOccurredAt(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const [iso, y, mo, d] = [m[0], +m[1]!, +m[2]!, +m[3]!];
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? undefined : iso.slice(0, 10);
}

/**
 * A directed relationship between two entities the model found in the same
 * content — e.g. {subject:'Sarah', relation:'works_at', object:'Lister'}.
 * `relation` is a free-text lowercase verb phrase: the taxonomy is emergent,
 * not a fixed vocabulary (the agent names relations as it sees them). Endpoints
 * are entity NAMES; they're resolved to entity ids at write time, and a
 * relation whose endpoints don't resolve is dropped.
 */
export type ExtractedRelation = {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
};

export type ExtractorOutput = {
  summary: string;
  facts: ExtractedFact[];
  entities: { name: string; kind: string }[];
  relations: ExtractedRelation[];
};

const FACT_KINDS = new Set(['factual', 'episodic', 'semantic', 'preference']);

/** Drop any entity mention whose name/kind is missing or blank. Models
 *  occasionally emit `{name: undefined, kind: 'person'}` or empty
 *  strings, which would crash reconcileEntity downstream on .trim(). */
export function sanitiseFactEntities(f: ExtractedFact): ExtractedFact {
  // Normalise occurred_at (snake_case from the model) → occurredAt, episodic only.
  const rawDate = (f as Record<string, unknown>).occurred_at ?? f.occurredAt;
  const occurredAt = f.kind === 'episodic' ? parseOccurredAt(rawDate) : undefined;
  if (!Array.isArray(f.entities)) return { ...f, occurredAt };
  const clean = f.entities.filter(isValidEntity);
  return { ...f, entities: clean, occurredAt };
}

export function isValidFact(f: unknown): f is ExtractedFact {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return (
    typeof o.content === 'string' && o.content.trim().length > 0 && FACT_KINDS.has(String(o.kind))
  );
}

export function isValidEntity(e: unknown): e is { name: string; kind: string } {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.trim().length > 0 &&
    typeof o.kind === 'string' &&
    o.kind.trim().length > 0
  );
}

const RELATION_MAX_LEN = 60;

/**
 * Vacuous verbs that carry no relational meaning (or merely restate
 * `mentioned_in`). A relation that canonicalises to one of these is dropped —
 * "X is Y" / "X related_to Y" pollute the graph without adding a queryable edge.
 */
const VACUOUS_RELATIONS = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'has',
  'have',
  'related_to',
  'associated_with',
  'connected_to',
  'linked_to',
  'mentioned_with',
  'about',
  'of',
]);

/**
 * Canonical synonyms — collapse different verbs for the SAME relation to one
 * stable form, so `graph_path(relations: ['employed_by'])` doesn't miss the
 * `works_at` edges. Deliberately TIGHT: only verbs that are unambiguously the
 * same relation. Senses that genuinely differ (e.g. `provides` a product vs
 * `provides_services_to`) are left distinct — over-merging loses meaning. The
 * taxonomy stays emergent; this only de-duplicates obvious synonyms.
 */
const RELATION_SYNONYMS: Record<string, string> = {
  // employment (X employed_by Y)
  works_at: 'employed_by',
  works_for: 'employed_by',
  employed_at: 'employed_by',
  employee_of: 'employed_by',
  receives_salary_from: 'employed_by',
  salaried_by: 'employed_by',
  // banking (X banks_with Y) — observed drift in stage-1 backfill
  holds_account_at: 'banks_with',
  maintains_account_at: 'banks_with',
  account_at: 'banks_with',
  banks_at: 'banks_with',
  // family / place / ownership
  spouse_of: 'married_to',
  located_at: 'located_in',
  based_in: 'located_in',
  owner_of: 'owns',
  founded: 'founder_of',
};

/** Canonicalise a snake_cased verb: '' if vacuous (caller drops it), else the
 *  synonym's canonical form, else the verb unchanged. Pure + exported for test. */
export function canonicaliseRelation(verb: string): string {
  if (VACUOUS_RELATIONS.has(verb)) return '';
  return RELATION_SYNONYMS[verb] ?? verb;
}

/** A relation is usable iff subject, relation, and object are all non-empty
 *  strings and subject !== object (no self-loops). */
export function isValidRelation(r: unknown): r is ExtractedRelation {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.subject === 'string' &&
    o.subject.trim().length > 0 &&
    typeof o.relation === 'string' &&
    o.relation.trim().length > 0 &&
    typeof o.object === 'string' &&
    o.object.trim().length > 0 &&
    o.subject.trim().toLowerCase() !== o.object.trim().toLowerCase()
  );
}

/** Normalise a parsed relation: trim endpoints, lowercase + snake_case the
 *  relation verb to a stable form, clamp confidence to [0,1] (default 0.8). */
export function sanitiseRelation(r: ExtractedRelation): ExtractedRelation {
  const relation = r.relation
    .trim()
    .toLowerCase()
    // any run of non-alphanumerics (spaces, hyphens, punctuation) → one "_"
    .replace(/[^a-z0-9]+/g, '_')
    // drop leading/trailing underscores left by edge punctuation
    .replace(/^_+|_+$/g, '')
    .slice(0, RELATION_MAX_LEN);
  // Collapse synonyms / drop vacuous verbs so the graph has a stable, queryable
  // vocabulary. canonicaliseRelation returns '' for vacuous verbs; the
  // parseExtractorOutput filter then drops the relation entirely.
  const canonical = canonicaliseRelation(relation);
  const confidence =
    typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0.8;
  return { subject: r.subject.trim(), relation: canonical, object: r.object.trim(), confidence };
}

/**
 * Extract the first balanced top-level JSON object from a string,
 * ignoring braces inside string literals. Returns the `{…}` substring
 * or null if no complete object is found.
 *
 * Why: smaller models (Haiku on a long document) often emit a valid
 * object then append explanatory prose, a second fenced block, or a
 * stray closing ``` — which makes a whole-string JSON.parse throw
 * "Unexpected non-whitespace character after JSON". Scanning to the
 * matching brace recovers the object the model actually produced. A
 * genuinely truncated response (unbalanced) still returns null and
 * falls through to the empty result.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated mid-object
}

/**
 * Parse the extractor LLM response with sanity defaults. Distinct log
 * lines for "the model returned bad JSON" vs "the model returned valid
 * JSON but no facts" — used to look identical, which made silent
 * prompt drift impossible to spot.
 *
 * The optional `context` is passed to the error log so an operator can
 * grep for "[extractor] LLM returned non-JSON" and find which node /
 * model caused the failure.
 */
export function parseExtractorOutput(
  raw: string,
  context?: { nodeId?: string; model?: string },
): ExtractorOutput {
  // Strip ```json fences if a model adds them.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fast path failed — most often the model appended prose or a stray
    // fence after a complete object. Recover the first balanced {…}.
    const candidate = extractFirstJsonObject(cleaned);
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        /* fall through to the empty-result log below */
      }
    }
    if (parsed === undefined) {
      console.error('[extractor] LLM returned non-JSON; producing empty result', {
        nodeId: context?.nodeId,
        model: context?.model,
        preview: cleaned.slice(0, 200),
      });
      return { summary: '', facts: [], entities: [], relations: [] };
    }
  }
  const obj = parsed as Partial<ExtractorOutput>;
  return {
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    facts: Array.isArray(obj.facts) ? obj.facts.filter(isValidFact).map(sanitiseFactEntities) : [],
    entities: Array.isArray(obj.entities) ? obj.entities.filter(isValidEntity) : [],
    relations: Array.isArray(obj.relations)
      ? obj.relations
          .filter(isValidRelation)
          .map(sanitiseRelation)
          // a verb that sanitised down to empty (all punctuation) is unusable
          .filter((r) => r.relation.length > 0)
      : [],
  };
}

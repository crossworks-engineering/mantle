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
};

export type ExtractorOutput = {
  summary: string;
  facts: ExtractedFact[];
  entities: { name: string; kind: string }[];
};

const FACT_KINDS = new Set(['factual', 'episodic', 'semantic', 'preference']);

/** Drop any entity mention whose name/kind is missing or blank. Models
 *  occasionally emit `{name: undefined, kind: 'person'}` or empty
 *  strings, which would crash reconcileEntity downstream on .trim(). */
export function sanitiseFactEntities(f: ExtractedFact): ExtractedFact {
  if (!Array.isArray(f.entities)) return f;
  const clean = f.entities.filter(isValidEntity);
  return { ...f, entities: clean };
}

export function isValidFact(f: unknown): f is ExtractedFact {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return (
    typeof o.content === 'string' &&
    o.content.trim().length > 0 &&
    FACT_KINDS.has(String(o.kind))
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
  } catch (err) {
    console.error('[extractor] LLM returned non-JSON; producing empty result', {
      nodeId: context?.nodeId,
      model: context?.model,
      message: (err as Error).message,
      preview: cleaned.slice(0, 200),
    });
    return { summary: '', facts: [], entities: [] };
  }
  const obj = parsed as Partial<ExtractorOutput>;
  return {
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    facts: Array.isArray(obj.facts)
      ? obj.facts.filter(isValidFact).map(sanitiseFactEntities)
      : [],
    entities: Array.isArray(obj.entities) ? obj.entities.filter(isValidEntity) : [],
  };
}

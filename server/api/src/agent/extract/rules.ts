/**
 * Extractor: the pure decision rules, kept free of db / model / tracing
 * imports so they can be unit-tested directly (2026-09-02 audit, gap D1: the
 * extractor's write path had two tested functions out of ~28). Each rule is
 * called from exactly one place in the DB-bound modules next to this file.
 */

export type ClassifierDecision = {
  decision: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  target_index: number | null;
  reason?: string;
};

/**
 * When a fact became true (`valid_from`). An episodic fact with a parsed event
 * date starts on that date. Any other fact starts no later than its source
 * document: an email's sent date, else the node's creation. It used to be the
 * ingest time, so every fact from imported history (a 2023 note, an old
 * email) looked brand new: recency ranking then favoured it over its episodic
 * siblings, and "newest first" put it ahead of later facts. Never in the
 * future: a clock-skewed source date clamps to now.
 */
export function factValidFrom(
  occurredAt: string | null | undefined,
  source: { createdAt: Date | string; data?: unknown },
  now: Date = new Date(),
): Date {
  if (occurredAt) {
    const event = new Date(`${occurredAt}T00:00:00Z`);
    if (!Number.isNaN(event.getTime())) return event;
  }
  const sent = (source.data as { internalDate?: unknown } | null | undefined)?.internalDate;
  const fromSent = typeof sent === 'string' || typeof sent === 'number' ? new Date(sent) : null;
  const doc = fromSent && !Number.isNaN(fromSent.getTime()) ? fromSent : new Date(source.createdAt);
  if (Number.isNaN(doc.getTime()) || doc > now) return now;
  return doc;
}

/** The fact classifier's JSON reply (optionally fenced) → a decision. Anything
 *  unparseable or off-vocabulary is a plain ADD: the safe default is to keep
 *  the new fact rather than retire an old one on garbage. */
export function parseClassifierDecision(raw: string): ClassifierDecision {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as ClassifierDecision;
    if (!['ADD', 'UPDATE', 'DELETE', 'NOOP'].includes(parsed.decision)) {
      return { decision: 'ADD', target_index: null };
    }
    return parsed;
  } catch {
    return { decision: 'ADD', target_index: null };
  }
}

/** Per-run fact cost cap from the worker params. 0, negative and non-numeric
 *  all mean "no cap": a literal 0 must NOT become "zero budget", because the
 *  llm_extract step has already spent by the time facts are processed and
 *  `spent >= 0` would drop every fact at #0. */
/**
 * Does a re-extract that found NO facts retire this node's live facts? Only
 * when the model read the document and answered: a non-empty summary from a
 * real run. Not when facts are off for the doc (retrieval-only, or the worker
 * says no), not on a reused table summary (no model ran), and not on a
 * non-JSON reply (parsed as an empty result, summary ''), which would
 * otherwise wipe good facts after a model hiccup.
 */
export function retiresOnNoFacts(input: {
  extractFacts: boolean | undefined;
  retrievalOnly: boolean;
  facts: number;
  reused: boolean | undefined;
  summary: string;
}): boolean {
  return (
    input.extractFacts !== false &&
    !input.retrievalOnly &&
    input.facts === 0 &&
    !input.reused &&
    input.summary.trim().length > 0
  );
}

export function resolveCostCap(raw: unknown): number | null {
  return typeof raw === 'number' && raw > 0 ? raw : null;
}

/** The alias to record on a matched entity for this mention's spelling, or
 *  null when it is already the canonical name (case-insensitively) or an
 *  existing alias. */
export function aliasToAdd(
  existing: { name: string; aliases: string[] },
  mention: string,
): string | null {
  if (existing.aliases.includes(mention)) return null;
  if (existing.name.toLowerCase() === mention.toLowerCase()) return null;
  return mention;
}

/** Among existing orgs, the one whose legal-suffix-stripped name equals the
 *  mention's ("Acme (Pty) Ltd" ↔ "Acme"), excluding an exact same name (that
 *  case was already handled upstream). `normalise` is the shared org-name
 *  normaliser, injected so this rule stays import-free. */
export function findOrgVariant<T extends { name: string }>(
  orgs: T[],
  mention: string,
  normalise: (name: string) => string | null | undefined,
): T | null {
  const norm = normalise(mention);
  if (!norm) return null;
  return (
    orgs.find(
      (o) => normalise(o.name) === norm && o.name.toLowerCase() !== mention.toLowerCase(),
    ) ?? null
  );
}

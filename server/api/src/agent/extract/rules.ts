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

export type VersionSibling = {
  id: string;
  createdAt: Date;
  salience: number;
  supersededBy: string | null;
  supersededReason: string | null;
};

/**
 * Which siblings of one file family to demote under the newest, and whether
 * the newest itself must be restored. Rules:
 *  - the newest sibling is the head ONLY if this heuristic owns its mark
 *    (reason null or 'version'); a manual 'corrected' / 'migrated' newest
 *    stands the whole heuristic down (writing edges into a retired node
 *    could close a cycle);
 *  - only heuristic-owned older siblings are demoted, and only when not
 *    already demoted under this head at the demoted salience;
 *  - the head is restored (salience 1, edge cleared) whenever a prior pass or
 *    a rename left a demotion or an edge on it.
 */
export function planFileVersionSupersede(
  family: VersionSibling[],
  demotedSalience: number,
): { headId: string | null; demoteIds: string[]; restoreHead: boolean } {
  const sorted = [...family].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const [newest, ...older] = sorted;
  const heuristicOwned = (s: VersionSibling) =>
    s.supersededReason === null || s.supersededReason === 'version';
  const headId = newest && heuristicOwned(newest) ? newest.id : null;
  if (!headId || !newest) return { headId: null, demoteIds: [], restoreHead: false };
  const demoteIds = older
    .filter((s) => heuristicOwned(s) && (s.salience > demotedSalience || s.supersededBy !== headId))
    .map((s) => s.id);
  const restoreHead = newest.salience < 1 || newest.supersededBy !== null;
  return { headId, demoteIds, restoreHead };
}

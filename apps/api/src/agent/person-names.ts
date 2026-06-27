/**
 * Person-name heuristics for the entity reconciler.
 *
 * The reconciler's trigram + embedding paths collapse "Don Carter" into the
 * existing "Alex Carter" entity because surname overlap alone is enough to
 * push similarity past the threshold. That's wrong for siblings / family /
 * any same-surname-different-people case.
 *
 * `isLikelyDifferentPerson` is the guard we layer on top: when reconciling a
 * `person` mention against a candidate match, it returns true ONLY when both
 * names look like full given-name + surname pairs with the same surname and
 * clearly different given names. **Conservative by design** — anything
 * ambiguous (single-token name, an initial, prefix overlap like Don/Donald or
 * John/Johnathan, a title in front of an initial) returns false, so the
 * existing trigram/embedding merge wins when we can't be certain.
 *
 * Pure helpers + colocated so the extractor stays focused; tested in
 * `person-names.test.ts`.
 */

const PERSON_TITLES = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'sir', 'lady', 'lord', 'fr',
]);

function stripTrailingDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

/**
 * Split a person name into tokens, dropping a leading honorific (Mr / Dr / …).
 * "Mr J Carter" → ["J", "Carter"]; "Dr. Mary Jones" → ["Mary", "Jones"];
 * "Modular" → ["Modular"]. Pure.
 */
export function tokenizePersonName(name: string): string[] {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && PERSON_TITLES.has(stripTrailingDot(tokens[0]!).toLowerCase())) {
    return tokens.slice(1);
  }
  return tokens;
}

/**
 * Two person names appear to belong to *different people* when they share a
 * surname but have clearly different given names. Returns false on any
 * ambiguity so the normal reconciler still wins by default. Pure.
 */
export function arePersonNamesDistinct(a: string, b: string): boolean {
  const ta = tokenizePersonName(a);
  const tb = tokenizePersonName(b);
  // Need at least given + surname on both sides to compare.
  if (ta.length < 2 || tb.length < 2) return false;
  const surnameA = ta[ta.length - 1]!.toLowerCase();
  const surnameB = tb[tb.length - 1]!.toLowerCase();
  if (surnameA !== surnameB) return false; // different surnames — normal logic applies
  const givenA = stripTrailingDot(ta[0]!).toLowerCase();
  const givenB = stripTrailingDot(tb[0]!).toLowerCase();
  // Initial-like (1–2 chars) on either side — could be the full given name of
  // the other; we can't be sure they're distinct.
  if (givenA.length <= 2 || givenB.length <= 2) return false;
  if (givenA === givenB) return false;
  // Prefix overlap → likely nickname/full-name pair (Don/Donald, John/Johnathan).
  if (givenA.startsWith(givenB) || givenB.startsWith(givenA)) return false;
  return true;
}

/**
 * Guard for the reconciler: would merging this `person` mention into the
 * given existing entity collapse two distinct people?
 *
 * Only fires for `kind === 'person'`; org/place/etc. always fall through to
 * the normal logic. An existing entity is considered distinct iff the
 * candidate clashes with EVERY one of its known names (primary + aliases) —
 * if even one alias is ambiguous or already matches, we let the merge proceed
 * (the entity likely already covers this person; step-1 exact match would
 * normally have caught it but this is belt-and-braces).
 */
export function isLikelyDifferentPerson(
  mention: { name: string; kind: string },
  existing: { name: string; aliases: string[] },
): boolean {
  if (mention.kind !== 'person') return false;
  const knownNames = [existing.name, ...(existing.aliases ?? [])];
  return knownNames.every((known) => arePersonNamesDistinct(mention.name, known));
}

/**
 * The one tag normaliser (A10 #15): every kind that stores a tag list
 * (notes, tasks, events, journal, contacts, draws, formulas, locations,
 * apps, pages, tables, secrets) wrote the same function by hand, twelve
 * copies byte for byte. A tag is trimmed and lower-cased, a blank or one
 * over TAG_MAX_LENGTH characters is dropped, a repeat is dropped, and at
 * most TAG_MAX_COUNT are kept, so a bad write cannot grow the row.
 */

/** The longest tag kept, in characters. */
export const TAG_MAX_LENGTH = 40;
/** The most tags an item keeps. */
export const TAG_MAX_COUNT = 20;

/** `tags` normalised for storage: trimmed, lower-cased, deduped, bounded. */
export function dedupeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > TAG_MAX_LENGTH || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

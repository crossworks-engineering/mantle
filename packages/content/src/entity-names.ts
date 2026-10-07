/**
 * Pure name rules for entity quality on document corpora (2026-10-03).
 *
 * Two failure modes seen on a brain of a few thousand sermon PDFs:
 *
 *  1. The extractor turned each document's own title ("0519 - Believing with
 *     the Heart [chs519]" → "Believing with the Heart") and the works it names
 *     ("Sermon #2268") into `project` / `event` entities. A title is not a
 *     project or an event; on a personal brain those kinds mean things the user
 *     does or attends. `isDocumentTitleMention` is the extractor's guard and
 *     `titleKey` is the shared comparison the cleanup script uses.
 *
 *  2. "C.H. Spurgeon" and "Charles Spurgeon" stayed two people, because
 *     neither trigram nor embedding similarity joins initials to a full given
 *     name. `personNamesCompatible` is that join, and it is conservative: the
 *     surname must match, both sides must carry a given name, and every given
 *     name both sides state must agree (equal, or an initial of the other).
 *     Different first names never match; a surname alone never matches.
 *
 * No db / model imports, so every rule is unit-tested directly.
 */

// ─── Document titles ─────────────────────────────────────────────────────────

/** Entity kinds a document's title (or a work it names) gets mislabelled as. */
const TITLE_PRONE_KINDS = new Set(['project', 'event']);

/** Node types whose title is the title of a document, not a thing the user
 *  does. A note or page titled "Kitchen renovation" can name a real project;
 *  an uploaded file's title names the file. */
const DOCUMENT_NODE_TYPES = new Set(['file', 'documentation', 'sermon']);

/**
 * A comparison key for a title or a title-like entity name: file extension,
 * square-bracket tags ("[chs519]"), a "(Sermon #1279)" label and a leading
 * catalogue number ("0519 - ", "0039-40 - ") removed, then lowercase alphanumerics with single spaces. Curly and straight
 * apostrophes are dropped so "Lord’s" = "Lord's" = "Lords".
 */
export function titleKey(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      .replace(/\.(pdf|epub|docx?|txt|md|html?|rtf|odt)\s*$/i, '')
      .replace(/\[[^\]]*\]/g, ' ')
      // a trailing "(Sermon #1279)" style label repeats the catalogue number
      .replace(
        /\(\s*(sermon|homily|lecture|chapter|volume|vol|part|episode|issue|hymn|no)\.?\s*(no\.?|#)?\s*\d+\s*\)/gi,
        ' ',
      )
      // leading catalogue number, also a range: "0519 - ", "0039-40 - "
      .replace(/^\s*\d+(\s*[-–]\s*\d+)?\s*[-–—:.)]\s*/, '')
      .toLowerCase()
      .replace(/['’‘`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/** A label that only numbers a work: "Sermon #2268", "Chapter 3", "Vol. II",
 *  "Episode 12". Never a project or an event in its own right. */
export function isNumberedWorkLabel(name: string): boolean {
  return /^(sermon|homily|lecture|chapter|chap|volume|vol|part|episode|issue|hymn)\.?\s*(no\.?|number|#)?\s*([0-9]+|[ivxlcdm]+)$/i.test(
    name.trim(),
  );
}

/**
 * Should the extractor drop this mention? True only for a `project` / `event`
 * mention on a document node (file, documentation, sermon) whose name is the
 * document's own title (compared by `titleKey`) or a bare numbered-work label.
 * Real projects and events, and every other kind, pass through.
 */
export function isDocumentTitleMention(
  mention: { name: string; kind: string },
  node: { type: string; title: string },
): boolean {
  if (!TITLE_PRONE_KINDS.has(mention.kind)) return false;
  if (!DOCUMENT_NODE_TYPES.has(node.type)) return false;
  if (isNumberedWorkLabel(mention.name)) return true;
  const key = titleKey(mention.name);
  return key.length >= 3 && key === titleKey(node.title);
}

// ─── Person names: initials ↔ full given names ───────────────────────────────

/** Leading honorifics dropped before comparing ("Rev. Dr. C. H. Spurgeon"). */
const LEADING_TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'miss',
  'dr',
  'prof',
  'rev',
  'revd',
  'reverend',
  'pastor',
  'sir',
  'dame',
  'lady',
  'lord',
  'fr',
  'father',
  'brother',
  'sister',
  'bishop',
  'elder',
  'deacon',
]);

/** Trailing generational / degree suffixes dropped before comparing. */
const TRAILING_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'phd', 'md']);

const bare = (t: string) => t.replace(/\.+$/, '').toLowerCase();

/**
 * Given names + surname of a person name, lowercased, or null when the name
 * has no given name ("Mrs. Spurgeon", "Spurgeon") or no usable surname. A run
 * of initials in one token ("C.H.") splits into one initial per letter.
 */
export function personNameParts(name: string): { given: string[]; surname: string } | null {
  let tokens = name
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .flatMap((t) => (/^([A-Za-z]\.){2,}$/.test(t) ? t.split('.').filter(Boolean) : [t]));
  while (tokens.length > 0 && LEADING_TITLES.has(bare(tokens[0]!))) tokens = tokens.slice(1);
  while (tokens.length > 0 && TRAILING_SUFFIXES.has(bare(tokens[tokens.length - 1]!)))
    tokens = tokens.slice(0, -1);
  if (tokens.length < 2) return null;
  const surname = bare(tokens[tokens.length - 1]!);
  // The surname must be a word, not an initial ("Charles H.").
  if (surname.length < 2 || !/^\p{L}/u.test(surname)) return null;
  const given = tokens.slice(0, -1).map(bare);
  if (given.some((g) => g.length === 0 || !/^\p{L}/u.test(g))) return null;
  return { given, surname };
}

/** Two given names agree: equal, or one is the initial of the other. */
function givenAgrees(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

/**
 * Do these two names plausibly name the same person? Same surname, a given
 * name on both sides, and the given names agree position by position as far
 * as both go: "C.H. Spurgeon" = "Charles Spurgeon" = "Charles Haddon
 * Spurgeon"; "Thomas Spurgeon" ≠ "C.H. Spurgeon"; "Mrs. Spurgeon" matches
 * nothing (no given name). Two different full first names never agree, so
 * "Charlie Smith" ≠ "Charles Smith" (stricter than the trigram path).
 */
export function personNamesCompatible(a: string, b: string): boolean {
  const pa = personNameParts(a);
  const pb = personNameParts(b);
  if (!pa || !pb || pa.surname !== pb.surname) return false;
  const n = Math.min(pa.given.length, pb.given.length);
  for (let i = 0; i < n; i++) if (!givenAgrees(pa.given[i]!, pb.given[i]!)) return false;
  return true;
}

/** Same surname, both with a given name, and the FIRST given names disagree:
 *  the names belong to different people ("J. A. Spurgeon" vs "C.H. Spurgeon").
 *  Used to prune aliases a past fuzzy merge attached to the wrong person. */
export function personNamesConflict(a: string, b: string): boolean {
  const pa = personNameParts(a);
  const pb = personNameParts(b);
  if (!pa || !pb || pa.surname !== pb.surname) return false;
  return !givenAgrees(pa.given[0]!, pb.given[0]!);
}

/**
 * The single existing person a mention resolves to by initials, or null when
 * none or more than one agrees (ambiguous: "J. Smith" with both "John Smith"
 * and "Jane Smith" on file stays its own entity).
 */
export function findPersonInitialsMatch<T extends { id: string; name: string }>(
  candidates: T[],
  mention: string,
): T | null {
  const hits = candidates.filter(
    (c) => c.name.toLowerCase() !== mention.toLowerCase() && personNamesCompatible(c.name, mention),
  );
  const unique = new Map(hits.map((h) => [h.id, h]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

/**
 * Group person entities into sets that all name the same person. Pairs are
 * joined by `personNamesCompatible`; a connected group merges only when EVERY
 * pair in it agrees. A group with a disagreeing pair ("J. Spurgeon" agrees
 * with both "John" and "James", who disagree) is returned as ambiguous and is
 * not merged.
 */
export function planPersonInitialMerges<T extends { id: string; name: string }>(
  persons: T[],
): { groups: T[][]; ambiguous: T[][] } {
  const parent = new Map<string, string>(persons.map((p) => [p.id, p.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  // Only same-surname names can agree, so compare within surname buckets.
  const bySurname = new Map<string, T[]>();
  for (const p of persons) {
    const parts = personNameParts(p.name);
    if (!parts) continue;
    const list = bySurname.get(parts.surname) ?? [];
    list.push(p);
    bySurname.set(parts.surname, list);
  }
  for (const list of bySurname.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (personNamesCompatible(list[i]!.name, list[j]!.name))
          parent.set(find(list[i]!.id), find(list[j]!.id));

  const comps = new Map<string, T[]>();
  for (const p of persons) {
    const root = find(p.id);
    const list = comps.get(root) ?? [];
    list.push(p);
    comps.set(root, list);
  }
  const groups: T[][] = [];
  const ambiguous: T[][] = [];
  for (const comp of comps.values()) {
    if (comp.length < 2) continue;
    const allAgree = comp.every((a, i) =>
      comp.slice(i + 1).every((b) => personNamesCompatible(a.name, b.name)),
    );
    (allAgree ? groups : ambiguous).push(comp);
  }
  return { groups, ambiguous };
}

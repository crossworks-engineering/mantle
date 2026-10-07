/**
 * Foldable headings: the shared rules every surface folds by.
 *
 * A heading can be FOLDABLE (Notion's toggle heading). The document stores
 * only that fact, plus an optional default for a reader who never chose:
 *
 *   heading attrs.fold   null | 'open' | 'closed'
 *   markdown             `## Title {fold}`   foldable, starts open
 *                        `## Title {fold=closed}`   foldable, starts folded
 *
 * Whether a heading is folded RIGHT NOW is the reader's own choice, not part
 * of the document: it is a reading preference, like a scroll position, and
 * one reader folding a section must not hide it from everyone else (nor make
 * a draft "changed"). The choice lives in the reader's localStorage, keyed by
 * the heading's block id, so it follows the heading across the editor, the
 * read view, the member and client views and the share reader of one browser.
 * Block ids are UUIDs, so one map holds every page; it keeps the most recent
 * FOLD_CHOICES_MAX choices.
 *
 * What a fold hides: the blocks after the heading, in the same parent, up to
 * the next heading of the same or a higher level (level <= the heading's), or
 * the end of the parent. A heading inside a callout or a column folds within
 * that container. Print always shows everything (CSS, see share-ui app.css).
 *
 * Pure and browser-safe. The storage helpers no-op where localStorage is
 * missing or refuses (SSR, private mode).
 */

export type HeadingFold = 'open' | 'closed';

/** The stored attr, normalised: anything else is "not foldable". */
export function normalizeFold(v: unknown): HeadingFold | null {
  return v === 'open' || v === 'closed' ? v : null;
}

/**
 * The trailing markdown marker, matched against a heading's LAST inline text
 * run (so an escaped `\{fold}` is plain text: `marked` splits the escape into
 * its own token). Group 1 is the optional `=open` / `=closed` value.
 */
export const FOLD_MARKER_RE = /\s*\{fold(?:=(open|closed))?\}\s*$/;

/**
 * A heading's trailing marker, read off its LAST inline `marked` token and
 * removed from it. An escaped `\{fold}` never matches: `marked` lexes the
 * escape as its own token, so the last text run is `fold}`. Shared by
 * markdownToDoc and the client's chat renderer, so both read it the same way.
 */
export function splitFoldMarker<T extends { type: string; text?: string }>(
  tokens: T[] | undefined,
): { tokens: T[] | undefined; fold: HeadingFold | null } {
  const last = tokens?.[tokens.length - 1];
  if (!tokens || !last || last.type !== 'text') return { tokens, fold: null };
  const m = FOLD_MARKER_RE.exec(last.text ?? '');
  if (!m) return { tokens, fold: null };
  const rest = (last.text ?? '').slice(0, m.index).replace(/\s+$/, '');
  const head = tokens.slice(0, -1);
  return {
    tokens: rest ? [...head, { ...last, text: rest }] : head,
    fold: m[1] === 'closed' ? 'closed' : 'open',
  };
}

/** The marker docToMarkdown writes for a stored fold value. */
export function foldMarker(fold: HeadingFold): string {
  return fold === 'closed' ? '{fold=closed}' : '{fold}';
}

/**
 * For each foldable heading among a run of SIBLING blocks, the index just past
 * its section (exclusive). `level(i)` is the heading level of sibling i, or
 * null when it is not a heading; `foldable(i)` says whether it folds.
 */
export function foldSections(
  count: number,
  level: (i: number) => number | null,
  foldable: (i: number) => boolean,
): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const lv = level(i);
    if (lv == null || !foldable(i)) continue;
    let end = i + 1;
    while (end < count) {
      const next = level(end);
      if (next != null && next <= lv) break;
      end++;
    }
    out.set(i, end);
  }
  return out;
}

/* ─────────────────────────── the reader's choices ─────────────────────────── */

export const FOLD_STORAGE_KEY = 'pages.headingFolds';
export const FOLD_CHOICES_MAX = 1000;

/** heading id → true (folded) / false (open). Absent = the document default. */
export type FoldChoices = Record<string, boolean>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readFoldChoices(): FoldChoices {
  const s = storage();
  if (!s) return {};
  try {
    const raw = JSON.parse(s.getItem(FOLD_STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: FoldChoices = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember one choice. The newest choices are kept, the oldest dropped. */
export function writeFoldChoice(id: string, folded: boolean): void {
  const s = storage();
  if (!s || !id) return;
  const choices = readFoldChoices();
  delete choices[id]; // re-insert at the end: insertion order = recency
  choices[id] = folded;
  const keys = Object.keys(choices);
  for (const k of keys.slice(0, Math.max(0, keys.length - FOLD_CHOICES_MAX))) delete choices[k];
  try {
    s.setItem(FOLD_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Quota or private mode: the fold still works for this view.
  }
}

/** Is this heading folded for this reader? Their choice, else the doc default. */
export function isFolded(
  id: string | null | undefined,
  fold: unknown,
  choices: FoldChoices,
): boolean {
  const f = normalizeFold(fold);
  if (!f) return false;
  if (id && typeof choices[id] === 'boolean') return choices[id]!;
  return f === 'closed';
}

/**
 * Embedded-asset text, folded for a LIVE read.
 *
 * Since always fold (workspaces plan 5.3, phase W2) no stored text folds an
 * embed's words in: `doc_text` and `scene_text` hold the item's own words
 * and a marker per embed (pages/level-text.ts, draw-scene-text.ts). This
 * fold is for a reader who reads the embeds too (draw-reader.ts redoes it
 * per reader, from what that reader may see).
 *
 * Pure. Depends on nothing else under pages/.
 */

/** Max chars of a single embedded file's extracted text folded into a page. */
export const EMBED_TEXT_PER_FILE = 4000;
/** Max total chars of embedded-asset text appended to a page's doc_text. */
export const EMBED_TEXT_TOTAL = 16000;

/**
 * Fold an ordered list of embedded files' extracted text into one bounded
 * plaintext block. Pure (no DB) so the bounds/format are unit-testable: each
 * file is capped at `perFile`, the whole block at `total`, empty/whitespace
 * text is skipped, and order is preserved (diff-friendly).
 */
export function foldEmbeddedText(
  items: { title: string; text: string | null | undefined; label?: string }[],
  perFile = EMBED_TEXT_PER_FILE,
  total = EMBED_TEXT_TOTAL,
): string {
  const parts: string[] = [];
  let budget = total;
  for (const it of items) {
    const text = it.text?.trim();
    if (!text) continue;
    const slice = text.slice(0, Math.min(perFile, budget));
    if (!slice) break;
    parts.push(`[${it.label ?? 'Embedded file'}: ${it.title}]\n${slice}`);
    budget -= slice.length;
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}

/**
 * chunkDocText — split flattened document text (typically the output of
 * docToText, but works on any plaintext body) into retrieval chunks.
 *
 * Greedy-packs lines up to ~maxChars, tracking the most recent markdown
 * heading as each chunk's section context. Overlong single lines are hard-
 * split. Always returns at least one chunk for non-empty input, so short docs
 * become a single whole-body chunk and retrieval is uniform across lengths.
 */

export type DocChunk = { text: string; headingPath: string | null };

const HEADING_RE = /^#{1,6}\s+(.+)$/;

export function chunkDocText(text: string, opts: { maxChars?: number } = {}): DocChunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? 1500);
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: DocChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let currentHeading: string | null = null;
  let chunkHeading: string | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({ text: buf.join('\n'), headingPath: chunkHeading });
    buf = [];
    bufLen = 0;
  };

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(HEADING_RE);
    if (m) currentHeading = m[1]!.trim();

    // Hard-split a single line longer than the budget.
    const pieces =
      line.length > maxChars ? (line.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [line]) : [line];

    for (const piece of pieces) {
      if (buf.length === 0) chunkHeading = currentHeading;
      if (bufLen + piece.length > maxChars && buf.length > 0) {
        flush();
        chunkHeading = currentHeading;
      }
      buf.push(piece);
      bufLen += piece.length + 1;
    }
  }
  flush();
  return chunks;
}

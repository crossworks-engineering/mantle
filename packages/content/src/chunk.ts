/**
 * chunkDocText — split flattened document text (typically the output of
 * docToText, but works on any plaintext body) into retrieval chunks.
 *
 * Greedy-packs lines up to ~maxChars, tracking the most recent markdown
 * heading as each chunk's section context. Overlong single lines are hard-
 * split. Always returns at least one chunk for non-empty input, so short docs
 * become a single whole-body chunk and retrieval is uniform across lengths.
 *
 * Consecutive chunks OVERLAP by ~overlapChars (the tail of one seeds the head
 * of the next), so a fact or sentence straddling a boundary is embedded whole
 * in at least one chunk rather than split across two and lost to retrieval.
 */

export type DocChunk = { text: string; headingPath: string | null };

const HEADING_RE = /^#{1,6}\s+(.+)$/;

export function chunkDocText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): DocChunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? 1500);
  // Cap overlap at half the chunk so each chunk still makes net forward progress.
  const overlapChars = Math.max(0, Math.min(opts.overlapChars ?? 150, Math.floor(maxChars / 2)));
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

  // Add overlap as a post-process: prepend the tail of each chunk to the next,
  // trimmed to a word boundary so we don't lead with a fragment. Predictable —
  // no interaction with the greedy packing above.
  if (overlapChars > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text;
      let tail = prev.slice(Math.max(0, prev.length - overlapChars));
      const sp = tail.search(/\s/);
      if (sp > 0) tail = tail.slice(sp + 1); // drop a leading partial word
      if (tail.trim()) chunks[i] = { ...chunks[i]!, text: `${tail.trim()}\n${chunks[i]!.text}` };
    }
  }

  return chunks;
}

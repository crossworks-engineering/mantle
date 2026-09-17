import { chunkDocText } from './chunk';

/** Chunk budget every embedded piece must respect — the same ~2.75k chars
 *  `chunkDocText` and `chunkSpreadsheetProfile` already self-cap to. */
const PIECE_MAX_CHARS = 2750;

/** How many parts one over-budget piece may fan out into. A data dictionary is
 *  real retrieval signal (tab/column names ground a table_sql call), unlike raw
 *  grid rows, so splitting beats truncating — but an unbounded split would
 *  re-create the vector-noise problem `chunk-spreadsheet.ts` exists to avoid. */
const PIECE_MAX_PARTS = 6;

/**
 * Hold every piece to the chunk budget before it reaches the embedder.
 *
 * The two chunkers below self-cap; the table PROFILE/SCHEMA pieces built by
 * `buildTableIndexPieces` did not. A wide workbook (50 tabs / 1,775 columns
 * observed in the field) rendered a data dictionary past the provider's
 * 8,192-token input ceiling, which is a hard 400 that rejects the WHOLE batch:
 * the node indexed zero chunks, the job burned its 5 retries, dead-lettered,
 * and `redriveDeadLetters` resurrected it on every agent start thereafter.
 *
 * Split rather than truncate — the schema chunk's whole job is grounding a
 * table_sql call, so silently dropping 40 of 50 tabs would defeat it.
 * `chunkDocText` packs on the `## <tab>` headings this text already uses and
 * hard-splits any single overlong line, so it needs no bespoke splitter. Past
 * PIECE_MAX_PARTS the tail is dropped and said so out loud, mirroring the grid
 * profiler's coverage note rather than pretending the dictionary is complete.
 */
export function clampPieces(
  // Accepts both shapes that reach here: the profile pieces (`headingPath?`)
  // and the chunkers' DocChunk (`headingPath: string | null`).
  pieces: { text: string; headingPath?: string | null }[],
): { text: string; headingPath?: string }[] {
  const out: { text: string; headingPath?: string }[] = [];
  for (const piece of pieces) {
    if (piece.text.length <= PIECE_MAX_CHARS) {
      out.push({ text: piece.text, headingPath: piece.headingPath ?? undefined });
      continue;
    }
    // overlapChars 0: overlap earns its keep on prose, where a sentence can
    // straddle a boundary. A column list has no such straddle, and duplicating
    // it would inflate an already-oversized piece.
    const parts = chunkDocText(piece.text, { maxChars: PIECE_MAX_CHARS, overlapChars: 0 });
    const kept = parts.slice(0, PIECE_MAX_PARTS);
    const dropped = parts.length - kept.length;
    kept.forEach((part, i) => {
      const last = i === kept.length - 1;
      const note =
        last && dropped > 0
          ? `\n[schema truncated — ${kept.length} of ${parts.length} parts indexed; call table_schema for the full dictionary]`
          : '';
      // The note has to fit INSIDE the budget, not on top of it — chunkDocText
      // already packed this part to the ceiling, so appending blind pushed the
      // final piece back over the limit this function exists to enforce.
      const body = note
        ? part.text.slice(0, Math.max(0, PIECE_MAX_CHARS - note.length))
        : part.text;
      out.push({
        text: `${body}${note}`,
        headingPath: piece.headingPath
          ? `${piece.headingPath}${parts.length > 1 ? ` (${i + 1}/${kept.length})` : ''}`
          : (part.headingPath ?? undefined),
      });
    });
  }
  return out;
}

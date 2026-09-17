/**
 * Extractor: Body text helpers: prompt truncation and whitespace cleanup, plus the size caps.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

/** Max characters of body text we feed the summarizer in one shot.
 *  Long emails / PDFs get truncated to keep the prompt bounded and the
 *  cost predictable. A summary is a spine, not a full recap. */
const BODY_MAX_CHARS = 24_000;

/** Max characters of extracted text we PERSIST as `data.text` for binary
 *  file nodes (pdf/docx/xlsx) whose body isn't otherwise stored. This is
 *  the retrievable full document — independent of the prompt truncation
 *  above. Single-user/family scale, so the cap is generous; it only
 *  exists to bound a pathologically huge OCR'd file, not real documents. */
export const TEXT_STORE_MAX_CHARS = 1_000_000;

/** Bound the body the LLM sees. Keeps head + tail so the model gets both
 *  the lede and the sign-off (which often carries the most action items in
 *  long emails). The FULL raw text is persisted separately (see
 *  `data.text` in the index pass) — this truncation is prompt-only. */
export function truncateForPrompt(body: string): string {
  if (body.length <= BODY_MAX_CHARS) return body;
  const head = body.slice(0, Math.floor(BODY_MAX_CHARS * 0.7));
  const tail = body.slice(-Math.floor(BODY_MAX_CHARS * 0.25));
  return `${head}\n\n[…truncated ${body.length - BODY_MAX_CHARS} chars…]\n\n${tail}`;
}

/**
 * Strip NUL bytes from extracted text. Postgres text/jsonb cannot
 * store a NUL — a write throws `unsupported Unicode escape sequence` — and
 * OCR / PDF parsers occasionally emit them. Left unhandled, a document that
 * read perfectly is lost on the persist step (18 invoice PDFs hit exactly
 * this). NULs carry no information, so dropping them is safe.
 */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping NUL is the whole point
  return s.replace(/\x00/g, '');
}

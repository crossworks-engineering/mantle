/**
 * A file's extraction state, for a person and an agent: did the brain read
 * the content, all of it, part of it, or not, and why (task 8d40932a). Before
 * this the only mark was `indexing_applied: 'full'`, which is the indexing
 * MODE, stamped before the read: a file the parser refused still said
 * "full", and nobody saw that its content was missing.
 *
 * Derived live from the keys the extractor already writes, so there is no
 * new state to keep in step:
 *  - `indexing_applied` 'metadata': the content is kept out on purpose;
 *  - `extract_skipped`: the extractor's verdict, a read failure or a skip.
 *    It holds while the key is there: new bytes drop it with the other byte
 *    keys (BYTE_DERIVED_DATA_KEYS) and a good read removes it. A rename or a
 *    move keeps it: they re-embed the title and read nothing, so the
 *    content is still not read (the drain's own "current" test, against
 *    updated_at, is about re-queuing, not about this);
 *  - `extract_parked`: the write of a finished read was refused;
 *  - `extract_completed_at`: a read that ended; `ocr.pages_read` and
 *    `ocr.pages_total` say when a scan was read in part;
 *  - none of these: not read yet (queued, retrying, or never queued).
 *
 * Pure, with no imports: the file listing, `node_read` and the tests share it.
 */

export type ExtractionState =
  'indexed' | 'partial' | 'failed' | 'skipped' | 'pending' | 'name_only';

export const EXTRACTION_STATES: readonly ExtractionState[] = [
  'indexed',
  'partial',
  'failed',
  'skipped',
  'pending',
  'name_only',
];

export type FileExtraction = {
  state: ExtractionState;
  /** The extractor's word for a skip or a failure (`document_unreadable`,
   *  `pdf_too_large`, ...), `parked`, or `local_only`. */
  reason?: string;
  /** One sentence for a person: what happened and what to do. */
  hint?: string;
  /** A scan read in part: the pages read and the pages in the file. */
  pages?: { read: number; total: number };
};

/** Verdicts that mean the content is there but could not be read. Every
 *  other terminal skip is a file with nothing to read (`skipped`). */
const READ_FAILURES: ReadonlySet<string> = new Set([
  'document_unreadable',
  'pdf_too_large',
  'encrypted_pdf',
  'bytes_unavailable',
]);

const HINTS: Readonly<Record<string, string>> = {
  document_unreadable:
    'The parser could not read this file (too large, too slow, or out of memory, twice). Its content is not in search; only its name is.',
  pdf_too_large:
    'The PDF is too large to read for OCR. Its content is not in search; only its name is.',
  encrypted_pdf:
    'The PDF is password-protected. Add its password in Settings > PDF passwords, then read it again.',
  bytes_unavailable:
    "The file's bytes are not in storage, so it could not be read. Upload it again.",
  parked: 'The file was read, but its index could not be written. An Admin can look at it.',
  needs_export:
    'This format cannot be read directly. Export it to a readable format and upload that.',
  unsupported_media:
    'Audio and video are stored but not read. Ask the assistant to transcribe it (video_ingest).',
  no_parser: 'No reader takes this file type. Only its name is in search.',
  body_too_short: 'The file holds too little text to index. Only its name is in search.',
  no_text_layer: 'The scan gave no text. Only its name is in search.',
  no_vision_text: 'The image gave no text to read. Only its name is in search.',
  local_only:
    'Read on this box with no model (its workspace has no assistant): its text is in search, with no summary.',
  not_read_no_model:
    'Not read: only its name is in search. A full read needs an assistant in its workspace.',
};

const PARTIAL_HINT = (read: number, total: number) =>
  `Only pages 1 to ${read} of ${total} were read. The other pages are not in search.`;

function hintOf(reason: string): string | undefined {
  return HINTS[reason];
}

/** The extraction state of a file node, from its `data`. */
export function extractionOf(
  data: Readonly<Record<string, unknown>> | null | undefined,
): FileExtraction {
  const d = data ?? {};
  if (d.indexing_applied === 'metadata') return { state: 'name_only' };

  const skip = d.extract_skipped as { reason?: unknown } | undefined;
  if (skip && typeof skip.reason === 'string') {
    const reason = skip.reason;
    const hint = hintOf(reason);
    return {
      state: READ_FAILURES.has(reason) ? 'failed' : 'skipped',
      reason,
      ...(hint ? { hint } : {}),
    };
  }
  if (d.extract_parked) return { state: 'failed', reason: 'parked', hint: HINTS.parked };

  if (d.extract_completed_at) {
    const ocr = d.ocr as { pages_read?: unknown; pages_total?: unknown } | undefined;
    const read = typeof ocr?.pages_read === 'number' ? ocr.pages_read : null;
    const total = typeof ocr?.pages_total === 'number' ? ocr.pages_total : null;
    if (read !== null && total !== null && read < total) {
      return { state: 'partial', pages: { read, total }, hint: PARTIAL_HINT(read, total) };
    }
    if (d.indexing_applied === 'local') {
      return { state: 'indexed', reason: 'local_only', hint: HINTS.local_only };
    }
    return { state: 'indexed' };
  }
  return { state: 'pending' };
}

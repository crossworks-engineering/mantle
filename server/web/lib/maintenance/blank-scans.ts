/**
 * Read again the PDF scans that drew blank before the decoders (docs/parser.md,
 * "Scans that drew blank before the decoders"; the fix is v0.400.56, `wasmUrl`
 * on every open). Until then pdfjs could not load its JPX, CCITT and JBIG2
 * decoders and drew such an image as a white page, with no error. What it left:
 * a terminal `no_text_layer` skip (no text, no embedding), or a model sentence
 * that the page is blank, indexed as the document (`data.ocr`).
 *
 * The finder spends nothing: SQL picks the PDFs page OCR read (never a native
 * read: no render ran there), then each file's bytes are searched for the three
 * filter names. Reading a hit again spends: the ocr-rescan path (a native PDF
 * call, then page OCR if that reads nothing, then a summary, an embedding and
 * facts). So `--apply` needs `--before=<date>`, the day this box got the fix: a
 * file read after it was read right and is never sent again. Each file sent is
 * stamped `data.blank_scan_reread`, in the transaction that clears it, so a
 * second run never sends it twice.
 *
 * Output is counts, ids and model names only: safe on a client box.
 */
import { sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { parserPdfPageCount, readFileById } from '@mantle/files';
import { clearForRescan, MAX_OCR_PAGES } from './ocr-rescan';

/** The image filters pdfjs needed a WebAssembly decoder for, as they appear
 *  in a PDF: an image's dictionary is plain text in the file, also in an
 *  encrypted one. An inline image can name CCITT `/CCF` inside a compressed
 *  content stream, which this search does not see. */
export const BLANK_CODECS = ['/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode'] as const;
export type BlankCodec = (typeof BLANK_CODECS)[number];

/** The `data` key that marks a file this remedy sent to be read again. */
export const REREAD_STAMP = 'blank_scan_reread';

/** Why a file is a candidate: page OCR read nothing (`no_text`), or read
 *  something that may be a sentence about a white page (`ocr_text`). */
export type BlankKind = 'no_text' | 'ocr_text';

export type BlankCandidate = {
  id: string;
  kind: BlankKind;
  /** When the file was last read (ISO), or null when the node does not say. */
  readAt: string | null;
  /** Characters of the text page OCR left (0 for none). */
  textChars: number;
};

/** The most characters a page of an `ocr_text` file may carry and still be
 *  read as a blank page: a model's sentence that a page is white is under
 *  100. A file with more text read its pages, and a codec it names is a logo
 *  or a stamp: it is left alone (`--ocr-max-chars` moves the line). */
export const OCR_MAX_CHARS_PER_PAGE = 200;

/** A hit worth reading again: page OCR read nothing, or no more text than a
 *  sentence a page. Page OCR reads at most MAX_OCR_PAGES pages, so a longer
 *  file is measured on those. Pure. */
export function likelyBlank(c: BlankCandidate, pages: number, maxPerPage: number): boolean {
  return c.kind === 'no_text' || c.textChars <= Math.min(pages, MAX_OCR_PAGES) * maxPerPage;
}

/** The filters of `BLANK_CODECS` that `bytes` names. Pure. */
export function blankCodecsIn(bytes: Buffer): BlankCodec[] {
  return BLANK_CODECS.filter((c) => bytes.includes(c, 0, 'latin1'));
}

/** `--before=YYYY-MM-DD` (or a full ISO time) as a Date, or null when it is
 *  not one. Pure. */
export function parseBefore(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(value)) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ApplyGate = { ok: true; before: Date | null } | { ok: false; message: string };

/**
 * The run's date, checked before anything is read. A date that is not one is
 * refused; `--apply` needs one; a date after `now` is refused, because it
 * would put back files read with the decoders (a typo of the month). Pure.
 */
export function applyGate(apply: boolean, beforeArg: string | undefined, now: Date): ApplyGate {
  const before = parseBefore(beforeArg);
  if (beforeArg !== undefined && !before)
    return { ok: false, message: `--before must be a date (YYYY-MM-DD), not '${beforeArg}'` };
  if (apply && !before)
    return {
      ok: false,
      message:
        '--apply needs --before=<YYYY-MM-DD>: the day this box got v0.400.56 or later. A file read after that was read right, and is never sent again.',
    };
  if (before && before.getTime() > now.getTime())
    return {
      ok: false,
      message: `--before ${before.toISOString().slice(0, 10)} is in the future: it must be the day this box got v0.400.56 or later, which has passed`,
    };
  return { ok: true, before };
}

/** Of `candidates`, those read before `before`. A file with no read time is
 *  left out: nothing says it was read before the fix. Pure. */
export function readBefore(candidates: BlankCandidate[], before: Date): BlankCandidate[] {
  return candidates.filter((c) => {
    if (!c.readAt) return false;
    const t = new Date(c.readAt).getTime();
    return !Number.isNaN(t) && t < before.getTime();
  });
}

/**
 * A candidate, as SQL on `nodes`: a brain-owned PDF file node page OCR read
 * (a terminal `no_text_layer` skip, or `data.ocr`) that this remedy has not
 * sent before. A native read (`data.native_pdf`) ran no render and is never
 * one, nor a metadata-only file (its content stays out). The finder lists by
 * it, and the write that sends a file checks it again in its own UPDATE: a
 * second run at the same time, or a file read again since the list, is left
 * alone.
 */
const IS_CANDIDATE = sql`(
  public.mantle_is_brain_space(${nodes.ownerId})
  and ${nodes.type} = 'file'
  and (lower(coalesce(${nodes.data}->>'filename', ${nodes.title})) like '%.pdf'
       or ${nodes.data}->>'mimeType' = 'application/pdf')
  and coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'
  and coalesce(${nodes.data}->>'indexing', '') <> 'metadata'
  and coalesce(${nodes.data}->>'native_pdf', '') <> 'true'
  and ${nodes.data}->>${REREAD_STAMP} is null
  and (${nodes.data}->'extract_skipped'->>'reason' = 'no_text_layer'
       or ${nodes.data}->>'ocr' = 'true')
)`;

/** Every candidate, oldest first. */
export async function findBlankCandidates(): Promise<BlankCandidate[]> {
  const rows = (await db.execute(sql`
    select ${nodes.id} as id,
           case when ${nodes.data}->'extract_skipped'->>'reason' = 'no_text_layer'
                then 'no_text' else 'ocr_text' end as kind,
           coalesce(${nodes.data}->>'extract_completed_at',
                    ${nodes.data}->'extract_skipped'->>'at') as read_at,
           coalesce(length(${nodes.data}->>'text'), 0)::int as text_chars
      from ${nodes}
     where ${IS_CANDIDATE}
     order by ${nodes.createdAt}
  `)) as unknown as Array<{
    id: string;
    kind: BlankKind;
    read_at: string | null;
    text_chars: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    readAt: r.read_at,
    textChars: Number(r.text_chars),
  }));
}

export type ByteScan = {
  /** Files that name a blank codec, with their page count. */
  hits: Map<string, { codecs: BlankCodec[]; pages: number }>;
  /** Files that name none: their blank verdict came from something else. */
  misses: string[];
  /** Bytes missing, or the parser could not count the pages. */
  unreadable: string[];
};

/** Read each file once: which name a blank codec, and how many pages each
 *  hit has (counted by the parser service: a PDF is never opened here). */
export async function scanBytes(ownerId: string, ids: string[]): Promise<ByteScan> {
  const out: ByteScan = { hits: new Map(), misses: [], unreadable: [] };
  for (const id of ids) {
    const file = await readFileById({ ownerId, fileId: id }).catch(() => null);
    if (!file) {
      out.unreadable.push(id);
      continue;
    }
    const codecs = blankCodecsIn(file.bytes);
    if (codecs.length === 0) {
      out.misses.push(id);
      continue;
    }
    const pages = await parserPdfPageCount(file.bytes).catch(() => null);
    if (pages && pages > 0) out.hits.set(id, { codecs, pages });
    else out.unreadable.push(id);
  }
  return out;
}

/** Clear one file for the extractor and stamp it as sent, in one transaction
 *  (ocr-rescan's clearForRescan with the stamp), only while it is still a
 *  candidate. False: it is not one any more, and nothing was written. */
export function prepareReread(id: string, at: Date = new Date()): Promise<boolean> {
  return clearForRescan(id, { stamp: { [REREAD_STAMP]: at.toISOString() }, onlyIf: IS_CANDIDATE });
}

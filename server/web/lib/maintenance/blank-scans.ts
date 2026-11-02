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
import { clearForRescan } from './ocr-rescan';

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
};

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
 * Brain-owned PDF file nodes page OCR read, that this remedy has not sent
 * before: a terminal `no_text_layer` skip, or `data.ocr`. A native read
 * (`data.native_pdf`) ran no render and is never one, nor a metadata-only
 * file (its content stays out).
 */
export async function findBlankCandidates(): Promise<BlankCandidate[]> {
  const rows = (await db.execute(sql`
    select n.id,
           case when n.data->'extract_skipped'->>'reason' = 'no_text_layer'
                then 'no_text' else 'ocr_text' end as kind,
           coalesce(n.data->>'extract_completed_at',
                    n.data->'extract_skipped'->>'at') as read_at
      from ${nodes} n
     where public.mantle_is_brain_space(n.owner_id)
       and n.type = 'file'
       and (lower(coalesce(n.data->>'filename', n.title)) like '%.pdf'
            or n.data->>'mimeType' = 'application/pdf')
       and coalesce(n.data->>'indexing_applied', '') <> 'metadata'
       and coalesce(n.data->>'indexing', '') <> 'metadata'
       and coalesce(n.data->>'native_pdf', '') <> 'true'
       and n.data->>${REREAD_STAMP} is null
       and (n.data->'extract_skipped'->>'reason' = 'no_text_layer'
            or n.data->>'ocr' = 'true')
     order by n.created_at
  `)) as unknown as Array<{ id: string; kind: BlankKind; read_at: string | null }>;
  return rows.map((r) => ({ id: r.id, kind: r.kind, readAt: r.read_at }));
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
 *  (ocr-rescan's clearForRescan with the stamp). */
export function prepareReread(id: string, at: Date = new Date()): Promise<void> {
  return clearForRescan(id, { [REREAD_STAMP]: at.toISOString() });
}

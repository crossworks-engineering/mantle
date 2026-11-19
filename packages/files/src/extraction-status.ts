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
 *  - `extract_completed_at`: a read that ended. It was read in part when
 *    anything says so, one model for every input (./read-cut.ts): the
 *    readers' `read_cut` (rows, sheets, characters, pictures, ...), a scan's
 *    (or a book's page windows') `ocr.pages_read` below `ocr.pages_total`,
 *    and the pictures a file left out (`data.images`, by part: `embedded`,
 *    over the cap or a window that failed, G4; `pages`, a book's pages left
 *    to vision with no page picture yet, G1). Each is one entry of `cuts`,
 *    with its sentence; `hint` is them all;
 *  - none of these: not read yet (queued, retrying, or never queued).
 *
 * Pure, with no imports but the pure ./read-cut.ts: the file listing,
 * `node_read` and the tests share it.
 */
import {
  cutMakesPartial,
  hasPartialReadCut,
  readCutViews,
  readCutsOf,
  SCAN_UNREAD_REASONS,
  type ReadCutView,
  type ReadCuts,
  type ScanUnreadReason,
} from './read-cut';

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
  /** Pictures left out (`data.images`): the pictures kept and found. */
  pictures?: { kept: number; found: number; more?: true };
  /** Each kind of cut, its counts and its sentence. A `partial` file's
   *  `hint` is the sentences of the cuts that make it partial, in order; an
   *  `indexed` file may carry the details only (read-cut.ts
   *  DETAIL_ONLY_CUT_REASONS), with no hint of them. */
  cuts?: ReadCutView[];
};

/** Verdicts that mean the content is there but could not be read. Every
 *  other terminal skip is a file with nothing to read (`skipped`). */
const READ_FAILURES: ReadonlySet<string> = new Set([
  'document_unreadable',
  'pdf_too_large',
  'encrypted_pdf',
  'bytes_unavailable',
  'file_too_large',
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
  file_too_large:
    'The file is larger than this box reads (an admin can raise MANTLE_MAX_UPLOAD_MB). It is stored and findable by its name; its content is not in search.',
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

/** One part of a file's pictures left out: the kept and the found. */
export type PicturesPart = { kept: number; found: number; more?: true };

/** The parts of `data.images` (G1, G4): `embedded`, the pictures the core
 *  read from the file; `pages`, a book's page pictures, one a page its
 *  reader left to vision, saved by its Agent. A part is there only while it
 *  leaves something out. */
export type PicturesParts = { embedded?: PicturesPart; pages?: PicturesPart };

const partOf = (v: unknown): PicturesPart | undefined => {
  const o = v as { kept?: unknown; found?: unknown; more?: unknown } | null | undefined;
  if (typeof o?.kept !== 'number' || typeof o.found !== 'number' || o.kept >= o.found) {
    return undefined;
  }
  return { kept: o.kept, found: o.found, ...(o.more === true ? { more: true as const } : {}) };
};

/** The parts of a stamp. A stamp with no parts (an older one) is of the
 *  embedded pictures. */
export function picturesPartsOf(images: unknown): PicturesParts {
  const o = (images ?? {}) as Record<string, unknown>;
  const hasParts = o.embedded !== undefined || o.pages !== undefined;
  const embedded = partOf(hasParts ? o.embedded : o);
  const pages = partOf(o.pages);
  return { ...(embedded ? { embedded } : {}), ...(pages ? { pages } : {}) };
}

/**
 * The next `data.images` after one part is counted again (`counts`, from
 * what is saved and what was found or marked): the parts, and `kept` and
 * `found` their sums, read by picturesLeftOut and the backfill. Null: no
 * part leaves anything out, and the key goes. Each part is written by its
 * one owner (the core's picture pass, a book's Agent), so neither writes
 * over the other's.
 */
export function picturesStampOf(
  images: unknown,
  part: keyof PicturesParts,
  counts: { kept: number; found: number; more?: boolean },
): (PicturesParts & PicturesPart) | null {
  const parts = picturesPartsOf(images);
  const found = Math.max(0, counts.found);
  const kept = Math.max(0, Math.min(counts.kept, found));
  if (kept < found) parts[part] = { kept, found, ...(counts.more ? { more: true as const } : {}) };
  else delete parts[part];
  const all = [parts.embedded, parts.pages].filter((p): p is PicturesPart => p !== undefined);
  if (all.length === 0) return null;
  return {
    ...parts,
    kept: all.reduce((n, p) => n + p.kept, 0),
    found: all.reduce((n, p) => n + p.found, 0),
    ...(all.some((p) => p.more) ? { more: true as const } : {}),
  };
}

/** The pictures a file left out (`data.images`), or null. */
export function picturesLeftOut(
  data: Readonly<Record<string, unknown>>,
): { kept: number; found: number; more?: true } | null {
  const img = data.images as { kept?: unknown; found?: unknown; more?: unknown } | undefined;
  const kept = typeof img?.kept === 'number' ? img.kept : null;
  const found = typeof img?.found === 'number' ? img.found : null;
  if (kept === null || found === null || kept >= found) return null;
  return { kept, found, ...(img?.more === true ? { more: true as const } : {}) };
}

/** A scan's pages unread by why (`ocr.unread`), checked: the known reasons
 *  with a count over 0, or undefined. */
function unreadOf(raw: unknown): Partial<Record<ScanUnreadReason, number>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Partial<Record<ScanUnreadReason, number>> = {};
  for (const r of SCAN_UNREAD_REASONS) {
    const v = (raw as Record<string, unknown>)[r];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[r] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Every cut of a read file, one model: the readers' `read_cut`, then the
 *  scan's pages and the pictures left out, each part an entry of its own. */
export function readCutsOfFile(d: Readonly<Record<string, unknown>>): ReadCuts {
  const cuts = readCutsOf(d.read_cut);
  const ocr = d.ocr as
    { pages_read?: unknown; pages_total?: unknown; unread?: unknown } | undefined;
  const read = typeof ocr?.pages_read === 'number' ? ocr.pages_read : null;
  const total = typeof ocr?.pages_total === 'number' ? ocr.pages_total : null;
  if (read !== null && total !== null && read < total) {
    const why = unreadOf(ocr?.unread);
    cuts.ocr_pages = { what: 'pages', read, total, ...(why ? { why } : {}) };
  }
  const parts = picturesPartsOf(d.images);
  if (parts.embedded) {
    cuts.pictures = {
      what: 'pictures',
      read: parts.embedded.kept,
      total: parts.embedded.found,
      ...(parts.embedded.more ? { atLeast: true as const } : {}),
    };
  }
  if (parts.pages) {
    cuts.page_pictures = { what: 'pages', read: parts.pages.kept, total: parts.pages.found };
  }
  return cuts;
}

function hintOf(reason: string): string | undefined {
  return HINTS[reason];
}

/** The extraction state of a file node, from its `data`. */
export function extractionOf(
  data: Readonly<Record<string, unknown>> | null | undefined,
): FileExtraction {
  const d = data ?? {};
  if (d.indexing_applied === 'metadata') return { state: 'name_only' };

  const skip = d.extract_skipped as { reason?: unknown; pages?: unknown } | undefined;
  if (skip && typeof skip.reason === 'string') {
    const reason = skip.reason;
    // A scan with no text says its pages and why each was not read (the
    // stamp's `pages`, a sentence of ScanUnreadReason clauses).
    const pages = typeof skip.pages === 'string' ? skip.pages.slice(0, 400) : '';
    const base = hintOf(reason);
    const hint = base && pages ? `${base} ${pages}` : base;
    return {
      state: READ_FAILURES.has(reason) ? 'failed' : 'skipped',
      reason,
      ...(hint ? { hint } : {}),
    };
  }
  if (d.extract_parked) return { state: 'failed', reason: 'parked', hint: HINTS.parked };

  if (d.extract_completed_at) {
    const views = readCutViews(readCutsOfFile(d));
    // The cuts that make the file partial; the details only (icons and
    // small pictures the size gate skipped: DETAIL_ONLY_CUT_REASONS) stay
    // in `cuts` but alone leave it indexed.
    const partial = views.filter((v) => cutMakesPartial(v.key));
    // A stored map with no entry this rule reads is still a cut said (the
    // SQL form tests the map's keys only): partial, with the generic
    // sentence.
    if (partial.length > 0 || hasPartialReadCut(d.read_cut)) {
      const ocr = views.find((v) => v.key === 'ocr_pages');
      const pics = picturesLeftOut(d);
      return {
        state: 'partial',
        hint:
          partial.map((v) => v.hint).join(' ') ||
          'The file was read in part. Read it again to see what was left out.',
        cuts: views,
        ...(ocr ? { pages: { read: ocr.read, total: ocr.total ?? ocr.read } } : {}),
        ...(pics ? { pictures: pics } : {}),
      };
    }
    const details = views.length > 0 ? { cuts: views } : {};
    if (d.indexing_applied === 'local') {
      return { state: 'indexed', reason: 'local_only', hint: HINTS.local_only, ...details };
    }
    return { state: 'indexed', ...details };
  }
  return { state: 'pending' };
}

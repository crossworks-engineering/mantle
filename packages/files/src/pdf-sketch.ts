/**
 * The sketch read: the text of a scanned drawing, read part by part by the
 * owner's vision model (plan page 11a16779, section 10.6a; docs/
 * file-ingestion.md, 3b). Pure: no pdfjs, no model call, no I/O. The parser
 * cuts and packs the pieces (`/pdf/pieces`, server/parser/cad/pdf_pieces.py),
 * the extract sends each packed picture to the vision worker
 * (server/api/src/agent/extract/pdf-sketch.ts), and this module holds what
 * both agree on: which pages are read, the prompt, how an answer is parsed,
 * and what the read gives (rows and the file's text).
 *
 * A vision model reads small text badly on a whole-page picture. So only
 * the places where text is are sent, at the page picture's own resolution,
 * each piece with its number: one call reads many pieces and answers
 * `number: text`, and each text goes back on the page with its piece's box.
 *
 * Nothing is left out in silence. A page past the page cap, a page with no
 * picture, a piece that did not fit and a piece the model gave no text for
 * are each stated: in the page's status, or as a row of the `Gaps` tab.
 */

import type { PdfDrawing, PdfDrawingPage } from './pdf-drawing';
import type { PdfKind } from './pdf-kind';
import type { Box } from './pdf-primitives';
import {
  CONFIDENCE,
  inTitleBlockCorner,
  tokenRows,
  type LineRow,
  type TagRow,
  type WordRow,
} from './pdf-rows';
import { tokensOf } from './pdf-tags';

/** The file kinds whose scan pages are read part by part. */
export const SKETCH_KINDS: readonly PdfKind[] = ['isometric', 'scan', 'other_drawing'];

/** Pages of one file the read takes on ingest, at most (the owner's
 *  decision P5: the page cap of the page OCR it replaces). */
export const SKETCH_MAX_PAGES = 10;
/** Packed pictures of one page, at most (decision P5). The parser's cutter
 *  holds the same number (`MAX_PICTURES` in pdf_pieces.py). */
export const SKETCH_MAX_PICTURES = 4;
/** The page picture the pieces are cut from: 300 DPI, or less on a sheet
 *  whose picture would pass the render cap. */
export const SKETCH_SCALE = 300 / 72;
/** Pieces of one page the answer is taken with, at most (the cutter packs
 *  no more: `MAX_PIECES` in pdf_pieces.py). */
export const SKETCH_MAX_PIECES = 400;
/** Characters of one piece's text that are kept. A piece is a line or a
 *  small block; a longer answer is not a reading of it. */
export const SKETCH_PIECE_MAX_CHARS = 400;

/**
 * What the vision model is asked for one packed picture. The answer is
 * parsed by {@link parsePieceAnswer}: one line a piece, `number: text`.
 */
export const SKETCH_PROMPT =
  'This picture holds numbered pieces cut from one scanned engineering drawing. ' +
  'Each piece is inside a thin grey frame, and its number is printed just left of the frame. ' +
  'Read the text in each piece exactly as it is written: keep every letter, digit, dash, slash, ' +
  'dot and inch mark, in the same order. Do not correct, translate, expand or complete anything, ' +
  'and do not describe the piece. ' +
  'Answer with one line for each piece, in the form `number: text`. ' +
  'When a piece holds text on several lines, give them on the one line with ` | ` between. ' +
  'When you cannot read a piece, or it holds no text, answer `number:` with nothing after it. ' +
  'Write nothing else.';

/** One piece of a page: where it is on the page, and where it was packed. */
export type SketchPiece = {
  /** In the page frame: fractions of the shown page, origin top left. */
  box: Box;
  /** The packed picture it is in (an index into the page's pictures). */
  picture: number;
  /** 1 when packed at its own size; less when it was made smaller to fit. */
  scale: number;
};

/**
 * Why a page has no pieces: `no_picture` (it could not be drawn, or the
 * job's time ran out), `refused` (the cutter refused the picture: white, or
 * too large), `over_budget` (the answer's picture budget was used up by the
 * pages before it).
 */
export type SketchPageStatus = 'ok' | 'no_picture' | 'refused' | 'over_budget';

/** The pieces of one page, as the parser gives them. */
export type SketchPagePieces = {
  page: number;
  status: SketchPageStatus;
  /** The resolution the pieces were cut at. */
  dpi: number;
  /** In order: piece `n` of an answer is entry `n - 1`. */
  pieces: SketchPiece[];
  /** Pieces that were cut and not packed: no room in the pictures. */
  notSent: Box[];
  pictures: Buffer[];
};

/**
 * One page's pieces with what the model answered for each of its pictures:
 * `answers[k]` is the answer text for picture `k`, or null when that call
 * did not run. Piece numbers run over the whole page, from 1, in order.
 */
export function sketchPageRead(
  page: SketchPagePieces,
  answers: readonly (string | null)[],
): SketchPageRead {
  const texts = new Map<number, string>();
  page.pictures.forEach((_, k) => {
    const answer = answers[k];
    if (answer === null || answer === undefined) return;
    const numbers = new Set<number>();
    page.pieces.forEach((piece, i) => {
      if (piece.picture === k) numbers.add(i + 1);
    });
    for (const [n, text] of parsePieceAnswer(answer, numbers)) texts.set(n, text);
  });
  const asked = (k: number) => answers[k] !== null && answers[k] !== undefined;
  return {
    page: page.page,
    status:
      page.status === 'ok' && page.pictures.length > 0 && !page.pictures.some((_, k) => asked(k))
        ? 'not_read'
        : page.status,
    dpi: page.dpi,
    pictures: page.pictures.length,
    pieces: page.pieces.map((piece, i) => ({
      box: piece.box,
      text: texts.get(i + 1) ?? null,
      asked: asked(piece.picture),
    })),
    notSent: page.notSent,
  };
}

/** One page after the vision read. */
export type SketchPageRead = {
  page: number;
  /** The page's own status, or `not_read`: no picture of it was read by
   *  the model (the worker did not run for it). */
  status: SketchPageStatus | 'not_read';
  dpi: number;
  pictures: number;
  pieces: {
    box: Box;
    /** What the model read; null when it gave no text for the piece. */
    text: string | null;
    /** True when the model answered for the picture this piece is in.
     *  False: the call for that picture did not run, so nothing is known
     *  of the piece. */
    asked: boolean;
  }[];
  notSent: Box[];
};

/** The sketch read of one file. */
export type SketchRead = {
  /** The vision model that read the pictures. */
  model: string;
  pages: SketchPageRead[];
  /** Scan pages of the file past {@link SKETCH_MAX_PAGES}: not read. */
  pagesPastCap: number[];
};

/** True for a page the sketch read takes: a picture of a page, or a drawn
 *  page with no text layer, that is not a typed document page. */
function isSketchPage(p: PdfDrawingPage): boolean {
  if (p.status !== 'ok' || p.kind === 'document') return false;
  return (
    p.class === 'scan' ||
    p.class === 'scan_hidden_text' ||
    p.class === 'raster_with_text' ||
    p.class === 'vector_no_text'
  );
}

/**
 * The pages of a drawing the sketch read takes, in page order, and those
 * past the cap. Empty for a file whose kind is no sketch kind.
 */
export function sketchPagesOf(
  drawing: PdfDrawing,
  kind: PdfKind = drawing.kind,
): { pages: number[]; pastCap: number[] } {
  if (!SKETCH_KINDS.includes(kind)) return { pages: [], pastCap: [] };
  const all = drawing.pages.filter(isSketchPage).map((p) => p.page);
  return { pages: all.slice(0, SKETCH_MAX_PAGES), pastCap: all.slice(SKETCH_MAX_PAGES) };
}

/**
 * The texts of one packed picture's answer, by piece number. A line counts
 * when it starts with a number that is one of `numbers` (the pieces of THIS
 * picture: a number the picture does not hold is the model's own, and is
 * dropped), then `:`. The first line of a number wins. A piece with no line,
 * or nothing after its number, has no entry.
 */
export function parsePieceAnswer(
  answer: string,
  numbers: ReadonlySet<number>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of answer.split(/\r?\n/)) {
    // `12: text`, also as a list item (`- 12: text`), with a word before the
    // number (`Piece 12: text`) or another mark after it (`12. text`).
    const m = /^\s*(?:[-*•]\s+)?[`*]*(?:piece\s+)?(\d{1,4})[`*]*\s*(?::|[.)]\s)(.*)$/i.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (!numbers.has(n) || out.has(n)) continue;
    const text = m[2]!
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^`+|`+$/g, '')
      .trim()
      .slice(0, SKETCH_PIECE_MAX_CHARS);
    if (text) out.set(n, text);
  }
  return out;
}

/** A place on a scan page where text is and none was read. */
export type SketchGap = {
  box: Box;
  /** `no_text_read`: the piece was sent and the model gave no text for it.
   *  `not_read`: the call for the piece's picture did not run.
   *  `not_sent`: the piece did not fit in the page's pictures. */
  why: 'no_text_read' | 'not_read' | 'not_sent';
};

/** The rows one page's read gives. A word's `line` is its piece's number. */
export type SketchPageRows = {
  words: WordRow[];
  tags: TagRow[];
  lines: LineRow[];
  gaps: SketchGap[];
};

/**
 * The rows of one page's read: a row a word (with its piece's box: the
 * model says what a piece holds, not where in it), the tags and line
 * numbers among them by the same grammar as a text layer, and a gap for
 * each piece with no text.
 */
export function sketchPageRows(
  read: SketchPageRead,
  widthMm: number,
  heightMm: number,
): SketchPageRows {
  const out: SketchPageRows = { words: [], tags: [], lines: [], gaps: [] };
  read.pieces.forEach((piece, i) => {
    if (piece.text === null) {
      out.gaps.push({ box: piece.box, why: piece.asked ? 'no_text_read' : 'not_read' });
      return;
    }
    const region = inTitleBlockCorner(piece.box, widthMm, heightMm) ? 'title_block' : 'body';
    // `|` stands between the lines of one piece (the prompt asks for it).
    for (const str of piece.text.split(/[\s|]+/).filter(Boolean)) {
      const at = out.words.length;
      out.words.push({
        line: i + 1,
        text: str,
        box: piece.box,
        angle: 0,
        sizeMm: 0,
        hidden: false,
        spaced: false,
        region,
      });
      for (const token of tokensOf(str)) {
        const found = tokenRows(token, piece.box, 'ocr', at, CONFIDENCE.ocrLess);
        out.tags.push(...found.tags);
        out.lines.push(...found.lines);
      }
    }
  });
  for (const box of read.notSent) out.gaps.push({ box, why: 'not_sent' });
  return out;
}

/**
 * The file's text from the read: for each page read, the text of its
 * markups (typed by a person: the surest text on a scan), then the pieces
 * in reading order, then the tags and line numbers found. Markdown, so a
 * reader sees the pages. '' when nothing was read.
 */
export function sketchMarkdown(drawing: PdfDrawing, read: SketchRead): string {
  const parts: string[] = [];
  for (const page of read.pages) {
    const p = drawing.pages.find((d) => d.page === page.page);
    const texts = page.pieces.map((piece) => piece.text).filter((t): t is string => t !== null);
    const markups = (p?.rows?.markups ?? []).filter((m) => m.text.trim());
    if (texts.length === 0 && markups.length === 0) continue;
    const rows = sketchPageRows(page, p?.widthMm ?? 210, p?.heightMm ?? 297);
    const uniq = (values: string[]) => [...new Set(values)];
    const tags = uniq([...rows.tags, ...(p?.rows?.tags ?? [])].map((t) => t.tag));
    const lines = uniq([...rows.lines, ...(p?.rows?.lines ?? [])].map((l) => l.line));
    parts.push(
      [
        `## Page ${page.page}`,
        markups.length > 0
          ? `Markups:\n${markups.map((m) => `- ${m.text.replace(/\s+/g, ' ').trim()}`).join('\n')}`
          : '',
        texts.length > 0 ? `Text read from the scan:\n${texts.join('\n')}` : '',
        tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
        lines.length > 0 ? `Line numbers: ${lines.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }
  return parts.join('\n\n');
}

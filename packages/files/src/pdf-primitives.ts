/**
 * Page primitives from a PDF drawing, read with pdfjs-dist through the one
 * opener (`withPdf`). The page reader of the PDF drawing read (dev-brain
 * page 11a16779, sections 4, 9.2 G3 and G7, 9.3 and 10): the parser's
 * `/pdf/drawing` job runs it through ./pdf-drawing.ts.
 *
 * Per page it gives, in ONE coordinate frame:
 *
 *  - origin at the top left of the page as it is shown, x to the right, y
 *    down; units a fraction of the shown width (x) and height (y). The page
 *    rotation, the CropBox and the UserUnit are applied (pdfjs's viewport
 *    holds all three), so the same spot on two sheets has the same numbers
 *    whatever frame each sheet was written in;
 *  - text lines, each with its words, an axis-aligned box and the angle of
 *    the baseline on the shown page, in degrees counterclockwise. They are
 *    put together here from the glyphs of the operator list (the text-showing
 *    operators, with the text state tracked as pdfjs's own renderer tracks
 *    it), not taken from `getTextContent`: so a word has its own box, hidden
 *    text is known per word, a glyph of no width moves nothing, and
 *    letter-spaced text is one word (see {@link wordsOf});
 *  - line and curve segments with their end points (`getOperatorList` with
 *    annotations off, with the current transform tracked through save,
 *    restore, transform and form XObjects); clip-only paths are left out; a
 *    filled path is closed; paths and images in optional content that is
 *    off are left out and counted;
 *  - annotations (`getAnnotations`) with kind, text and box; Link and Popup
 *    are left out (a Popup repeats its parent's text), and so are Hidden and
 *    NoView ones and those in optional content that is off (counted).
 *    Annotation appearances never add segments.
 *
 * Hidden text: a glyph drawn in an invisible render mode (3 or 7) or in
 * optional content that is off is hidden. A word is `hidden` when every one
 * of its glyphs is, and a line when every one of its words is. Hidden text
 * stays in `texts` with its flag: on a scan it is an old OCR layer, and on a
 * drawing it can be the only form of a tag. `textMayIncludeHidden` says the
 * page holds some.
 *
 * The text check: `getTextContent` is still read, only to count its
 * characters. `stats.textCheck` holds both counts, and a caller states a
 * page where the two readers disagree.
 *
 * Budgets: a page with more segments than `maxSegments`, or that takes
 * longer than `maxMs`, returns `{ status: 'too_large' }` with the reason and
 * the count. It never returns a part of the page as if it were the whole.
 * pdfjs cannot be stopped, so after the first page over time, a file's later
 * pages are stated `too_large` (time) without being read. A file also has
 * its own time budget, `maxFileMs`, checked before each page: once the file
 * has used it, the later pages are stated `too_large` (time) with that
 * limit. A file can so run over `maxFileMs` by about one page's `maxMs`.
 * `getPage` is under the page budget too: a time-out there gives the same
 * `too_large` (time) result, with no frame.
 *
 * Page count: `numPages` is the count pdfjs gives, and there is no other.
 * pdfjs does not hand the declared /Count of the page tree to its caller,
 * so this reader cannot compare the two. A broken page tree can make the
 * count short: at a kid that is not a page, pdfjs walks the tree again and
 * stops at the first bad kid, so the good pages after it get no result.
 * In that walk the bad kid is always the LAST page, and `getPage` on it
 * fails. So the file result has ONE flag, `pageCountMayBeShort`: true when
 * page `numPages` cannot be opened (an error or a time-out). The flag
 * catches the common case. It cannot catch the case where the walk itself
 * throws: pdfjs then sets the count to 1, and page 1 can come back ok.
 * That case is not detectable here.
 *
 * Known limits: a word's box is its baseline and the font size above it,
 * not the ink of its glyphs; vertical writing-mode fonts are counted
 * (`verticalRuns`) and their boxes are rough (rotated text is exact). Drawn content
 * that this walk does not follow (tiling-pattern cells, shading fills,
 * Type3 glyph drawings) is counted (`notWalked`), not read. Segments and
 * annotations wholly outside the shown page are kept and counted
 * (`outsideFrame`); a text line wholly outside it is left out and counted,
 * as pdfjs's own text reader leaves it out.
 */

import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { withPdf, type WithPdfOptions } from './pdf-open';

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** x0, y0, x1, y1 in the page frame (fractions; x0 <= x1, y0 <= y1). */
export type Box = [number, number, number, number];

/** One word of a text line. */
export type Word = {
  str: string;
  box: Box;
  /** Every glyph of it is drawn invisible, or in optional content that is off. */
  hidden: boolean;
  /** Put together from glyphs set apart by letter spacing (no space
   *  character between them). Read it with care: single characters drawn
   *  at even gaps look the same. */
  spaced: boolean;
};

/** A text line: glyphs that follow each other on one baseline. */
export type TextRun = {
  /** The words, with one space between. */
  str: string;
  box: Box;
  /** Baseline angle on the shown page, degrees counterclockwise, (-180, 180]. */
  angle: number;
  /** Font size on paper, in millimetres. */
  sizeMm: number;
  /** pdfjs's font id (a loaded-font name, not the PDF's BaseFont). */
  font: string;
  /** Every word of it is hidden. */
  hidden: boolean;
  words: Word[];
};

/**
 * A drawn line (`L`) or curve (`C`, end points only), from a to b, with how
 * it was painted: `w` the stroke width on paper in millimetres (0 for a
 * path that is filled and not stroked), `c` its colour as `#rrggbb` (the
 * stroke colour, or the fill colour of a fill; '' when the colour is a
 * pattern or was never set as RGB), `d` true for a dashed stroke.
 */
export type Segment = {
  kind: 'L' | 'C';
  a: [number, number];
  b: [number, number];
  w: number;
  c: string;
  d: boolean;
};

export type Annotation = {
  kind: string;
  text: string;
  box: Box;
  /** Who made it (the annotation's title), or ''. */
  author: string;
};

export type PageStats = {
  /** Glyphs in text-showing operators, and those in render mode 3 or 7. */
  glyphs: number;
  hiddenGlyphs: number;
  /** Share of the page covered by painted images (box area, clamped, summed,
   *  max 1). An image op that paints one image at many places counts each place. */
  imageCover: number;
  /** Paths with fill or stroke, and the segments in them. */
  paths: number;
  /** Optional content that is off: segments and images left out, glyphs
   *  counted (their runs still come through, see the module note). */
  ocHiddenSegments: number;
  ocHiddenImages: number;
  ocHiddenGlyphs: number;
  /** Annotations left out for the Hidden or NoView flag, or for optional
   *  content that is off. */
  hiddenAnnotations: number;
  /** Content this walk does not follow, so its lines and pictures are not
   *  in the counts: a tiling pattern set as a colour (its cell), a shading
   *  fill, text shown in a Type3 font (its glyph drawings), and each markup
   *  annotation kept (what its appearance draws). */
  notWalked: number;
  /** Text lines in a vertical writing-mode font (their boxes are rough). */
  verticalRuns: number;
  /** Characters with no white space: `own` in `texts`, `pdfjs` in what
   *  `getTextContent` gives for the page. They differ when one of the two
   *  readers lost or added text. */
  textCheck: { own: number; pdfjs: number };
  /** Items whose box is wholly outside the shown page (0..1). Segments and
   *  annotations are kept; text lines are left out of `texts`. */
  outsideFrame: { segments: number; annotations: number; texts: number };
  ms: number;
};

export type PageFrame = {
  page: number;
  /** Shown size on paper, millimetres (rotation, CropBox and UserUnit applied). */
  widthMm: number;
  heightMm: number;
  rotate: number;
  userUnit: number;
};

/** A page never opened (out of range, or skipped after a file over time)
 *  has only its number: no frame is made up for it. */
type Head = PageFrame | { page: number };

export type PagePrimitives =
  | (PageFrame & {
      status: 'ok';
      /** True when the page holds glyphs in an invisible render mode or in
       *  optional content that is off (`hiddenGlyphs + ocHiddenGlyphs > 0`).
       *  pdfjs cannot say which run they are in, so `texts` may hold them.
       *  Check this before you trust `texts` as shown text. */
      textMayIncludeHidden: boolean;
      texts: TextRun[];
      segments: Segment[];
      annotations: Annotation[];
      stats: PageStats;
    })
  | (Head & {
      status: 'too_large';
      /** `text`: more glyphs than `maxGlyphs`; no text is given. */
      reason: 'segments' | 'time' | 'text';
      /** The budget that was passed. */
      limit: number;
      /** Segments counted (reason segments), glyphs counted (reason text) or
       *  ms spent (reason time). For
       *  a page skipped because an earlier page was over time: 0. For a page
       *  skipped because the file was over `maxFileMs`: the file's ms so far
       *  (and `limit` is `maxFileMs`). */
      seen: number;
      ms: number;
      /** Reason segments only: the page's text runs, annotations and counts,
       *  which the path budget does not bound. The segments are not given:
       *  a part of them would read as the whole. */
      textMayIncludeHidden?: boolean;
      texts?: TextRun[];
      annotations?: Annotation[];
      stats?: PageStats;
    })
  | (Head & { status: 'failed'; code: string; ms: number });

/** Fixed failure codes of the reader itself. */
export const PAGE_OUT_OF_RANGE = 'page_out_of_range';

export type Budgets = {
  maxSegments: number;
  /** Glyphs of one page. Default 400,000. */
  maxGlyphs?: number;
  /** Time for one page. */
  maxMs: number;
  /** Time for the file's pages, from after the open (the open itself is
   *  not on this clock), checked before each page. Default 300,000 ms. */
  maxFileMs?: number;
};

/**
 * Defaults from the phase 0 sample (plan 9.6): the P&ID class has a median of
 * about 32,000 segments a page; 10 of 2,044 pages hold more than 100,000 and
 * one holds 6.0 million. The file budget, 5 minutes, is 10 pages at the full
 * page budget; the measured median page took about 0.15 s. The glyph budget
 * is far over a real page (the fullest P&ID sheet measured holds about
 * 20,000 characters): it only stops a page made to fill the memory.
 */
export const DEFAULT_BUDGETS: Required<Budgets> = {
  maxSegments: 250_000,
  maxGlyphs: 400_000,
  maxMs: 30_000,
  maxFileMs: 300_000,
};

// ─── matrices ─────────────────────────────────────────────────────────

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

/** m1 then m2 is NOT this: this is pdf.js's Util.transform(m1, m2), i.e.
 *  a point goes through m2 first, then m1. */
function mul(m1: M, m2: ArrayLike<number>): M {
  return [
    m1[0] * m2[0]! + m1[2] * m2[1]!,
    m1[1] * m2[0]! + m1[3] * m2[1]!,
    m1[0] * m2[2]! + m1[2] * m2[3]!,
    m1[1] * m2[2]! + m1[3] * m2[3]!,
    m1[0] * m2[4]! + m1[2] * m2[5]! + m1[4],
    m1[1] * m2[4]! + m1[3] * m2[5]! + m1[5],
  ];
}

function apply(m: M, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function isMatrix(a: unknown): a is ArrayLike<number> {
  return (
    !!a &&
    typeof a === 'object' &&
    typeof (a as ArrayLike<number>).length === 'number' &&
    (a as ArrayLike<number>).length >= 6
  );
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function boxOf(pts: [number, number][]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [round(x0), round(y0), round(x1), round(y1)];
}

// ─── timing ───────────────────────────────────────────────────────────

class OverTime extends Error {
  override readonly name = 'OverTime';
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    // p is dropped: catch it, so a later fault (the file closed) is not
    // an unhandled rejection. The race below already watches p.
    p.catch(() => {});
    return Promise.reject(new OverTime());
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new OverTime()), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** Path or image-op data this reader does not know (an op code, or data
 *  cut short). The page fails: a short path or a lost image would be a
 *  silently dropped item. */
class BadPath extends Error {
  override readonly name = 'BadPath';
}

/** Error names that may leave a box: fixed labels, never a message. */
const KNOWN_ERRORS = new Set([
  'BadPath',
  'PasswordException',
  'InvalidPDFException',
  'FormatError',
  'UnknownErrorException',
  'AbortException',
  'PdfLimitError',
]);
export function errorCode(err: unknown): string {
  const n = err instanceof Error ? err.name : '';
  return KNOWN_ERRORS.has(n) ? n : 'other';
}

// ─── text from glyphs ─────────────────────────────────────────────────

/** How a path was painted (the three fields of a {@link Segment}). */
type Paint = { w: number; c: string; d: boolean };

/** The graphics state this walk tracks. */
type Gs = {
  ctm: M;
  /** Text render mode. */
  mode: number;
  font: string;
  /** Font size, never negative; `dir` is -1 for a negative size. */
  size: number;
  dir: number;
  charSpace: number;
  wordSpace: number;
  hScale: number;
  leading: number;
  rise: number;
  /** Text matrix and the position in it, as pdfjs's renderer keeps them. */
  tm: M;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  lineWidth: number;
  stroke: string;
  fill: string;
  dash: boolean;
};

/** One placed glyph: its character, and its baseline from `a` to `b` in
 *  user space. */
type Glyph = {
  ch: string;
  space: boolean;
  hidden: boolean;
  a: [number, number];
  b: [number, number];
};

/** Glyphs that follow each other on one baseline. */
type GlyphLine = {
  /** Unit vector along the baseline, user space. */
  along: [number, number];
  /** From the baseline up, one font size long. */
  up: [number, number];
  height: number;
  font: string;
  vertical: boolean;
  glyphs: Glyph[];
};

function unit(x: number, y: number): [number, number] | null {
  const len = Math.hypot(x, y);
  return len > 0 && Number.isFinite(len) ? [x / len, y / len] : null;
}

/** Characters that are not white space, in the NFKC form (both text readers
 *  are counted the same way). */
const charCount = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').length;

/** The `[key, value]` pairs of a setGState op. */
function gStatePairs(a: unknown[] | null): [string, unknown][] {
  const list = a?.[0];
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is [string, unknown] => Array.isArray(p) && typeof p[0] === 'string');
}

/** The font a setGState op sets, as `[font id, size]`. */
function gStateFont(a: unknown[] | null): [string, number] | null {
  for (const [key, value] of gStatePairs(a)) {
    if (key === 'Font' && Array.isArray(value)) return [String(value[0] ?? ''), Number(value[1])];
  }
  return null;
}

/** A dash pattern with a length in it (an empty one is a solid line). */
function isDashed(pattern: unknown): boolean {
  const p = pattern as ArrayLike<number> | null | undefined;
  if (!p || typeof p.length !== 'number') return false;
  for (let i = 0; i < p.length; i++) if (Number(p[i]) > 0) return true;
  return false;
}

/** A gap between two glyphs, in font sizes, past which the next glyph
 *  starts a new line: a little over the widest letter spacing
 *  ({@link SPACED_MAX_GAP}), so a line is one phrase and a table cell or a
 *  label beside it is a line of its own. */
const LINE_MAX_GAP = 1.2;

/**
 * Whether `g` goes on at the end of `line`: the same direction and size,
 * on the same baseline (within 0.3 of the font size), and from half a size
 * back to {@link LINE_MAX_GAP} sizes on from the last glyph's end.
 */
function follows(line: GlyphLine, g: Glyph, along: [number, number], height: number): boolean {
  const last = line.glyphs.at(-1)!;
  const h = line.height;
  if (along[0] * line.along[0] + along[1] * line.along[1] < 0.999) return false;
  if (Math.abs(height - h) > 0.15 * h) return false;
  const dx = g.a[0] - last.b[0];
  const dy = g.a[1] - last.b[1];
  const on = dx * line.along[0] + dy * line.along[1];
  const off = Math.abs(dx * line.along[1] - dy * line.along[0]);
  return off <= 0.3 * h && on >= -0.5 * h && on <= LINE_MAX_GAP * h;
}

/** A gap, in font sizes, that parts two words when the line is not
 *  letter-spaced: about the width of a space. */
export const WORD_GAP = 0.25;
/** No letter spacing is wider than this many font sizes: a wider gap always
 *  parts two words. */
export const SPACED_MAX_GAP = 1;

/**
 * Cut one line's glyphs into words. `at[i]` is glyph i's start and end
 * along the baseline, in font sizes.
 *
 * A space character always parts two words. Between two glyphs with no
 * space character, a gap parts them when it is wider than a space
 * ({@link WORD_GAP}) AND clearly wider than the line's usual gap (1.8 times
 * its median, plus 0.1), or wider than any letter spacing
 * ({@link SPACED_MAX_GAP}). So text drawn with letter spacing (even gaps
 * between its glyphs, no space characters) is one word, marked `spaced`,
 * where a reader that judges each gap alone gives single letters.
 */
export function wordsOf(
  glyphs: readonly { ch: string; space: boolean; hidden: boolean }[],
  at: readonly (readonly [number, number])[],
): { from: number; to: number; str: string; hidden: boolean; spaced: boolean }[] {
  // The gaps between neighbours with no space character between them.
  const gaps: number[] = [];
  let prev = -1;
  let spaceSince = false;
  for (let i = 0; i < glyphs.length; i++) {
    if (glyphs[i]!.space) {
      spaceSince = true;
      continue;
    }
    if (prev >= 0 && !spaceSince) gaps.push(at[i]![0] - at[prev]![1]);
    prev = i;
    spaceSince = false;
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const median = sorted.length >= 2 ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  const limit = Math.max(WORD_GAP, 1.8 * Math.max(0, median) + 0.1);

  const out: { from: number; to: number; str: string; hidden: boolean; spaced: boolean }[] = [];
  let word: (typeof out)[number] | null = null;
  prev = -1;
  spaceSince = false;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    if (g.space) {
      spaceSince = true;
      continue;
    }
    const gap = prev >= 0 ? at[i]![0] - at[prev]![1] : 0;
    if (word && (spaceSince || gap > SPACED_MAX_GAP || gap > limit)) {
      out.push(word);
      word = null;
    }
    if (!word) word = { from: i, to: i, str: g.ch, hidden: g.hidden, spaced: false };
    else {
      word.to = i;
      word.str += g.ch;
      word.hidden &&= g.hidden;
      if (gap > WORD_GAP) word.spaced = true;
    }
    prev = i;
    spaceSince = false;
  }
  if (word) out.push(word);
  return out;
}

/** One glyph line as a text run in the page frame, or null when it holds
 *  no character. */
function textRunOf(line: GlyphLine, toFrame: M, viewport: M, mmPerUser: number): TextRun | null {
  const { along, up, height, glyphs } = line;
  const o = glyphs[0]!.a;
  const pos = (p: [number, number]) =>
    ((p[0] - o[0]) * along[0] + (p[1] - o[1]) * along[1]) / height;
  const at = glyphs.map((g) => [pos(g.a), pos(g.b)] as const);
  const quad = (from: Glyph, to: Glyph): [number, number][] => [
    apply(toFrame, from.a[0], from.a[1]),
    apply(toFrame, to.b[0], to.b[1]),
    apply(toFrame, to.b[0] + up[0], to.b[1] + up[1]),
    apply(toFrame, from.a[0] + up[0], from.a[1] + up[1]),
  ];
  const corners: [number, number][] = [];
  const words: Word[] = [];
  for (const w of wordsOf(glyphs, at)) {
    const q = quad(glyphs[w.from]!, glyphs[w.to]!);
    corners.push(...q);
    words.push({ str: w.str, box: boxOf(q), hidden: w.hidden, spaced: w.spaced });
  }
  if (words.length === 0) return null;
  // The baseline direction on the shown page: in page units, not
  // fractions, so a non-square page does not skew the angle.
  const p0 = apply(viewport, o[0], o[1]);
  const p1 = apply(viewport, o[0] + along[0], o[1] + along[1]);
  let angle = (Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]) * 180) / Math.PI;
  if (angle <= -180) angle += 360;
  return {
    str: words.map((w) => w.str).join(' '),
    box: boxOf(corners),
    angle: Math.round(angle * 100) / 100 + 0, // + 0: no -0
    sizeMm: Math.round(height * mmPerUser * 1000) / 1000,
    font: line.font,
    hidden: words.every((w) => w.hidden),
    words,
  };
}

// ─── one page ─────────────────────────────────────────────────────────

/** The part of pdfjs's OptionalContentConfig this reader uses. */
export type OcConfig = { isVisible(group: unknown): boolean };

/** PDF annotation flags (PDF 32000 table 165): Hidden (bit 2), NoView (bit 6). */
const ANNOT_NOT_SHOWN = 0x02 | 0x20;

/** True when a box lies wholly outside the shown page. */
const outsideFrame = (b: Box) => b[2] < 0 || b[0] > 1 || b[3] < 0 || b[1] > 1;

/**
 * Read one page. `pdfjs` is the module `withPdf` hands its callback (for
 * `OPS`). `oc` is the document's optional content config
 * (`doc.getOptionalContentConfig()`); without it all optional content counts
 * as shown. Never throws for a page fault: it returns `status: 'failed'` with
 * a fixed error label.
 */
export async function readPagePrimitives(
  pdfjs: Pdfjs,
  page: PDFPageProxy,
  budgets: Budgets = DEFAULT_BUDGETS,
  oc: OcConfig | null = null,
): Promise<PagePrimitives> {
  const t0 = Date.now();
  const left = () => budgets.maxMs - (Date.now() - t0);
  // Only the page number until the viewport is read: no frame is made up.
  let frame: Head = { page: page.pageNumber };
  const overTime = (): PagePrimitives => ({
    ...frame,
    status: 'too_large',
    reason: 'time',
    limit: budgets.maxMs,
    seen: Date.now() - t0,
    ms: Date.now() - t0,
  });

  try {
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width;
    const H = vp.height;
    // User space to the page frame: the viewport (rotation, CropBox origin,
    // UserUnit, y flip), then divide by the shown size.
    const toFrame: M = mul([1 / W, 0, 0, 1 / H, 0, 0], vp.transform);
    const userUnit = Number(page.userUnit) || 1;
    const shown: PageFrame = {
      page: page.pageNumber,
      widthMm: round((W / 72) * 25.4),
      heightMm: round((H / 72) * 25.4),
      rotate: Number(page.rotate) || 0,
      userUnit,
    };
    frame = shown;

    // ── paths, images, render modes ──
    // Annotations off: their appearance streams come with their own
    // matrices (annotation begin and end ops), which this walk does not
    // track. Annotations are read through getAnnotations below.
    const ol = await within(
      page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE }),
      left(),
    );
    const OPS = pdfjs.OPS;
    const imageOps = new Set(
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintSolidColorImageMask,
        OPS.paintImageXObjectRepeat,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObjectGroup,
      ].filter((x) => x !== undefined),
    );
    const textOps = new Set(
      [
        OPS.showText,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText,
      ].filter((x) => x !== undefined),
    );
    // A fill closes every subpath of its path (PDF 32000 8.5.3.3).
    const fillOps = new Set([
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ]);
    // A stroke paints its path's lines; a fill alone does not.
    const strokeOps = new Set([
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ]);
    const fn = ol.fnArray;
    const args = ol.argsArray as unknown[];
    const mmPerUser = (25.4 / 72) * userUnit;
    const maxGlyphs = budgets.maxGlyphs ?? DEFAULT_BUDGETS.maxGlyphs;
    // The fonts of the page, before the walk: a glyph's advance needs its
    // font's matrix and its writing mode. A font that fails to load counts
    // as a plain one.
    const fonts = new Map<string, { scale: number; vertical: boolean; type3: boolean }>();
    for (let k = 0; k < fn.length; k++) {
      const a = args[k] as unknown[] | null;
      const id =
        fn[k] === OPS.setFont
          ? String(a?.[0] ?? '')
          : fn[k] === OPS.setGState
            ? (gStateFont(a)?.[0] ?? '')
            : '';
      if (!id || fonts.has(id)) continue;
      const f = (await within(
        new Promise<unknown>((res) => page.commonObjs.get(id, res)),
        left(),
      )) as { fontMatrix?: ArrayLike<number>; vertical?: boolean; isType3Font?: boolean } | null;
      fonts.set(id, {
        scale: Number(f?.fontMatrix?.[0]) || 0.001,
        vertical: f?.vertical === true,
        type3: f?.isType3Font === true,
      });
    }
    // The graphics state, as q saves it and a form saves it. pdfjs's own
    // renderer keeps the text position in it too, so this walk does.
    let gs: Gs = {
      ctm: IDENTITY,
      mode: 0,
      font: '',
      size: 0,
      dir: 1,
      charSpace: 0,
      wordSpace: 0,
      hScale: 1,
      leading: 0,
      rise: 0,
      tm: IDENTITY,
      x: 0,
      y: 0,
      lineX: 0,
      lineY: 0,
      lineWidth: 1,
      stroke: '#000000',
      fill: '#000000',
      dash: false,
    };
    const stack: Gs[] = [];
    // Stack depth just after each open form's own save. A restore at or
    // below it is a stray Q in the form: it must not pop the form's save.
    const forms: number[] = [];
    const setFont = (id: unknown, size: unknown) => {
      const n = Number(size) || 0;
      gs.font = String(id ?? '');
      gs.size = Math.abs(n);
      gs.dir = n < 0 ? -1 : 1;
    };
    const moveText = (x: number, y: number) => {
      gs.x = gs.lineX += x;
      gs.y = gs.lineY += y;
    };
    // Text ops per font id, to count the Type3 ones.
    const textOpsByFont = new Map<string, number>();
    let notWalked = 0;
    let glyphs = 0;
    let hiddenGlyphs = 0;
    let imageCover = 0;
    let paths = 0;
    let counted = 0;
    // Marked content levels: false for optional content that is off.
    const mc: boolean[] = [];
    let ocOff = 0;
    let ocHiddenSegments = 0;
    let ocHiddenImages = 0;
    let ocHiddenGlyphs = 0;
    const segments: Segment[] = [];
    const lines: GlyphLine[] = [];
    let line: GlyphLine | null = null;
    for (let k = 0; k < fn.length; k++) {
      const op = fn[k];
      const a = args[k] as unknown[] | null;
      const num = (i: number) => Number(a?.[i]) || 0;
      if (op === OPS.save) stack.push({ ...gs });
      else if (op === OPS.restore) {
        if (stack.length > (forms.at(-1) ?? 0)) gs = stack.pop()!;
      } else if (op === OPS.transform) {
        if (a && a.length >= 6) gs.ctm = mul(gs.ctm, a as number[]);
      } else if (op === OPS.paintFormXObjectBegin) {
        stack.push({ ...gs });
        forms.push(stack.length);
        if (a && isMatrix(a[0])) gs.ctm = mul(gs.ctm, a[0]);
      } else if (op === OPS.paintFormXObjectEnd) {
        // Saves the form left open are dropped with it.
        const depth = forms.pop();
        if (depth !== undefined && stack.length > depth) stack.length = depth;
        const saved = stack.pop();
        if (saved) gs = saved;
      } else if (op === OPS.setFont) {
        setFont(a?.[0], a?.[1]);
      } else if (op === OPS.setGState) {
        const font = gStateFont(a);
        if (font) setFont(font[0], font[1]);
        for (const [key, value] of gStatePairs(a)) {
          if (key === 'LW') gs.lineWidth = Math.abs(Number(value)) || 0;
          else if (key === 'D') gs.dash = isDashed((value as unknown[] | null)?.[0]);
        }
      } else if (op === OPS.setLineWidth) {
        gs.lineWidth = Math.abs(num(0));
      } else if (op === OPS.setDash) {
        gs.dash = isDashed(a?.[0]);
      } else if (op === OPS.setStrokeRGBColor) {
        gs.stroke = typeof a?.[0] === 'string' ? a[0] : '';
      } else if (op === OPS.setFillRGBColor) {
        gs.fill = typeof a?.[0] === 'string' ? a[0] : '';
      } else if (op === OPS.setStrokeTransparent) {
        gs.stroke = '';
      } else if (op === OPS.setFillTransparent) {
        gs.fill = '';
      } else if (op === OPS.shadingFill) {
        if (ocOff === 0) notWalked++;
      } else if (op === OPS.setFillColorN || op === OPS.setStrokeColorN) {
        // A pattern, not a colour.
        if (op === OPS.setFillColorN) gs.fill = '';
        else gs.stroke = '';
        if (a?.[0] === 'TilingPattern' && ocOff === 0) notWalked++;
      } else if (op === OPS.beginMarkedContent) {
        mc.push(true);
      } else if (op === OPS.beginMarkedContentProps) {
        const shown = a?.[0] !== 'OC' || !oc || oc.isVisible(a[1]);
        mc.push(shown);
        if (!shown) ocOff++;
      } else if (op === OPS.endMarkedContent) {
        if (mc.pop() === false) ocOff--;
      } else if (op === OPS.setTextRenderingMode) {
        gs.mode = num(0);
      } else if (op === OPS.beginText) {
        gs.tm = IDENTITY;
        gs.x = gs.y = gs.lineX = gs.lineY = 0;
      } else if (op === OPS.setCharSpacing) {
        gs.charSpace = num(0);
      } else if (op === OPS.setWordSpacing) {
        gs.wordSpace = num(0);
      } else if (op === OPS.setHScale) {
        gs.hScale = num(0) / 100;
      } else if (op === OPS.setLeading) {
        gs.leading = -num(0);
      } else if (op === OPS.setTextRise) {
        gs.rise = num(0);
      } else if (op === OPS.moveText) {
        moveText(num(0), num(1));
      } else if (op === OPS.setLeadingMoveText) {
        gs.leading = num(1);
        moveText(num(0), num(1));
      } else if (op === OPS.setTextMatrix) {
        // pdfjs 6 gives one array of six; older lists gave six numbers.
        const m = isMatrix(a?.[0]) ? a[0] : a;
        if (isMatrix(m)) {
          gs.tm = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
          gs.x = gs.y = gs.lineX = gs.lineY = 0;
        }
      } else if (op === OPS.nextLine) {
        moveText(0, gs.leading);
      } else if (op === OPS.constructPath) {
        // [paint op, [Float32Array path data], minMax]; a clip-only path
        // ends with endPath and draws nothing.
        if (!a || a[0] === OPS.endPath) continue;
        const holder = a[1] as ArrayLike<unknown> | undefined;
        const data = holder?.[0] as ArrayLike<number> | null | undefined;
        if (!data || typeof data.length !== 'number') continue;
        const m = mul(toFrame, gs.ctm);
        const fill = fillOps.has(a[0] as number);
        const stroked = strokeOps.has(a[0] as number);
        // The width on paper: the user-space width through the transform's
        // scale (the root of its area factor).
        const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));
        const paint: Paint = {
          w: stroked ? Math.round(gs.lineWidth * scale * mmPerUser * 1000) / 1000 || 0 : 0,
          c: stroked ? gs.stroke : gs.fill,
          d: stroked && gs.dash,
        };
        if (ocOff > 0) {
          ocHiddenSegments += addSegments(data, m, segments, 0, fill, paint);
          continue;
        }
        paths++;
        counted += addSegments(
          data,
          m,
          segments,
          counted < budgets.maxSegments ? budgets.maxSegments - counted : 0,
          fill,
          paint,
        );
      } else if (imageOps.has(op!)) {
        if (ocOff > 0) {
          ocHiddenImages++;
          continue;
        }
        // An image fills the unit square of its transform.
        for (const place of imagePlaces(op!, a, OPS)) {
          const m = mul(mul(toFrame, gs.ctm), place);
          const b = boxOf([apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]);
          const w = Math.max(0, Math.min(1, b[2]) - Math.max(0, b[0]));
          const h = Math.max(0, Math.min(1, b[3]) - Math.max(0, b[1]));
          imageCover += w * h;
        }
      } else if (textOps.has(op!)) {
        const arr = Array.isArray(a?.[0]) ? (a[0] as unknown[]) : [];
        const font = fonts.get(gs.font);
        const vertical = font?.vertical === true;
        const hidden = gs.mode === 3 || gs.mode === 7 || ocOff > 0;
        // Text space to user space, and one glyph-space unit in text space.
        const base = mul(gs.ctm, gs.tm);
        const advance = gs.size * (font?.scale ?? 0.001);
        const hScale = gs.hScale * gs.dir;
        // The baseline's direction and the way up from it, in user space.
        const along = vertical
          ? unit(-base[2], -base[3])
          : unit(base[0] * hScale, base[1] * hScale);
        const up: [number, number] = [base[2] * gs.size, base[3] * gs.size];
        const height = Math.hypot(up[0], up[1]);
        let x = 0;
        let g = 0;
        for (const item of arr) {
          if (typeof item === 'number') {
            x += ((vertical ? 1 : -1) * item * gs.size) / 1000;
            continue;
          }
          if (!item || typeof item !== 'object') continue;
          g++;
          const glyph = item as {
            unicode?: unknown;
            width?: unknown;
            isSpace?: unknown;
            vmetric?: ArrayLike<number> | null;
          };
          const spacing = (glyph.isSpace ? gs.wordSpace : 0) + gs.charSpace;
          // As pdfjs's renderer: a vertical glyph goes down by its own metric.
          const own =
            (vertical && glyph.vmetric ? -Number(glyph.vmetric[0]) : Number(glyph.width)) || 0;
          const width = own * advance;
          const step = vertical ? width - spacing * gs.dir : width + spacing * gs.dir;
          // Only what can be placed is kept, and only inside the budget.
          if (glyphs + g <= maxGlyphs && along && height > 0 && Number.isFinite(height)) {
            const y = gs.y + gs.rise;
            const from = vertical ? apply(base, gs.x, y - x) : apply(base, gs.x + x * hScale, y);
            const to = vertical
              ? apply(base, gs.x, y - x - width)
              : apply(base, gs.x + (x + width) * hScale, y);
            const ch = typeof glyph.unicode === 'string' ? glyph.unicode.replace(/\0/g, '') : '';
            const placed: Glyph = {
              ch,
              // By the character, not by `isSpace`: that flag is the
              // character CODE 32 (what word spacing applies to), and a
              // subset font can put any glyph at that code.
              space: !ch.trim(),
              hidden,
              a: from,
              b: to,
            };
            if (line && !follows(line, placed, along, height)) {
              lines.push(line);
              line = null;
            }
            line ??= { along, up, height, font: gs.font, vertical, glyphs: [] };
            line.glyphs.push(placed);
          }
          x += step;
        }
        if (vertical) gs.y -= x;
        else gs.x += x * hScale;
        glyphs += g;
        if (gs.mode === 3 || gs.mode === 7) hiddenGlyphs += g;
        if (ocOff > 0) ocHiddenGlyphs += g;
        else textOpsByFont.set(gs.font, (textOpsByFont.get(gs.font) ?? 0) + 1);
      }
    }
    if (line) lines.push(line);
    // Type3 glyphs are drawings of their own (the font's char procs), which
    // this walk does not follow.
    for (const [id, n] of textOpsByFont) if (fonts.get(id)?.type3) notWalked += n;
    // More glyphs than the budget: no text is given, a part would read as
    // the whole.
    if (glyphs > maxGlyphs) {
      page.cleanup();
      return {
        ...shown,
        status: 'too_large',
        reason: 'text',
        limit: maxGlyphs,
        seen: glyphs,
        ms: Date.now() - t0,
      };
    }
    // Over the path budget: the text and the annotations are still read
    // (they are not bounded by it), and the page is stated too large below.
    const overSegments = counted > budgets.maxSegments;
    if (overSegments) segments.length = 0;
    let segmentsOutside = 0;
    for (const s of segments) if (outsideFrame(boxOf([s.a, s.b]))) segmentsOutside++;

    // ── text ──
    const texts: TextRun[] = [];
    let verticalRuns = 0;
    let ownChars = 0;
    let textsOutside = 0;
    for (const l of lines) {
      const run = textRunOf(l, toFrame, vp.transform as M, mmPerUser);
      if (!run) continue;
      // Text wholly outside the shown page is not on the sheet: left out,
      // as pdfjs's own text reader leaves it out, and counted.
      if (outsideFrame(run.box)) {
        textsOutside++;
        continue;
      }
      if (l.vertical) verticalRuns++;
      ownChars += charCount(run.str);
      texts.push(run);
    }
    // The check: the same page through pdfjs's own text reader, counted.
    const tc = await within(page.getTextContent(), left());
    let pdfjsChars = 0;
    for (const it of tc.items) if ('str' in it && it.str) pdfjsChars += charCount(it.str);

    // ── annotations ──
    // Intent 'any': the display intent drops NoView annotations unseen;
    // they are counted below instead.
    const annots = (await within(page.getAnnotations({ intent: 'any' }), left())) as {
      subtype?: string;
      rect?: number[];
      annotationFlags?: number;
      /** The annotation's optional content (its /OC), as pdfjs parsed it. */
      oc?: unknown;
      contentsObj?: { str?: string };
      titleObj?: { str?: string };
      /** The lines of a FreeText's own appearance, when it has no Contents. */
      textContent?: unknown;
      fieldValue?: unknown;
    }[];
    const annotations: Annotation[] = [];
    let hiddenAnnotations = 0;
    let annotationsOutside = 0;
    for (const an of annots) {
      const kind = String(an?.subtype ?? '');
      if (!kind || kind === 'Link' || kind === 'Popup') continue;
      if ((Number(an.annotationFlags) || 0) & ANNOT_NOT_SHOWN) {
        hiddenAnnotations++;
        continue;
      }
      if (an.oc && oc && !oc.isVisible(an.oc)) {
        hiddenAnnotations++;
        continue;
      }
      const r = an.rect ?? [0, 0, 0, 0];
      const fv = an.fieldValue;
      // A multi-value field (a list box) keeps its values apart.
      const text =
        kind === 'Widget'
          ? Array.isArray(fv)
            ? fv.join('\n')
            : fv == null
              ? ''
              : String(fv)
          : String(an.contentsObj?.str ?? '') ||
            (Array.isArray(an.textContent) ? an.textContent.map(String).join('\n') : '');
      const box = boxOf([
        apply(toFrame, r[0]!, r[1]!),
        apply(toFrame, r[2]!, r[1]!),
        apply(toFrame, r[2]!, r[3]!),
        apply(toFrame, r[0]!, r[3]!),
      ]);
      if (outsideFrame(box)) annotationsOutside++;
      // What a markup draws (its appearance: a stamp's picture, the ink of
      // a sketch) is not read by this walk, which runs with annotations off.
      if (kind !== 'Widget') notWalked++;
      annotations.push({ kind, text, box, author: String(an.titleObj?.str ?? '') });
    }
    page.cleanup();
    if (left() < 0) return overTime();
    const stats: PageStats = {
      glyphs,
      hiddenGlyphs,
      imageCover: Math.round(Math.min(1, imageCover) * 1000) / 1000,
      paths,
      ocHiddenSegments,
      ocHiddenImages,
      ocHiddenGlyphs,
      hiddenAnnotations,
      notWalked,
      verticalRuns,
      textCheck: { own: ownChars, pdfjs: pdfjsChars },
      outsideFrame: {
        segments: segmentsOutside,
        annotations: annotationsOutside,
        texts: textsOutside,
      },
      ms: Date.now() - t0,
    };
    const textMayIncludeHidden = hiddenGlyphs + ocHiddenGlyphs > 0;
    if (overSegments) {
      return {
        ...shown,
        status: 'too_large',
        reason: 'segments',
        limit: budgets.maxSegments,
        seen: counted,
        ms: stats.ms,
        textMayIncludeHidden,
        texts,
        annotations,
        stats,
      };
    }
    return { ...shown, status: 'ok', textMayIncludeHidden, texts, segments, annotations, stats };
  } catch (err) {
    try {
      page.cleanup();
    } catch {
      /* nothing to do */
    }
    if (err instanceof OverTime) return overTime();
    return { ...frame, status: 'failed', code: errorCode(err), ms: Date.now() - t0 };
  }
}

/** Numbers each pdfjs 6 DrawOPS code takes after it. */
const DRAW_ARGS = [2, 2, 6, 4, 0];

/**
 * Walk one path's data (pdfjs 6 DrawOPS: 0 moveTo x y, 1 lineTo x y,
 * 2 curveTo x1 y1 x2 y2 x y, 3 quadraticCurveTo x1 y1 x y, 4 closePath),
 * push up to `room` segments in the page frame, and return how many it
 * counted (all of them, also past `room`, so a page over budget can say by
 * how much). With `fill`, every open subpath is closed. A line or curve with
 * no current point only sets the point (no segment from the origin). An
 * unknown op code or data cut short throws `BadPath`. Every segment of the
 * path carries its `paint`.
 */
function addSegments(
  data: ArrayLike<number>,
  m: M,
  out: Segment[],
  room: number,
  fill: boolean,
  paint: Paint,
): number {
  let n = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let hasPoint = false;
  let open = false; // the subpath has a segment since its start
  const push = (kind: 'L' | 'C', x: number, y: number) => {
    n++;
    if (n <= room) {
      const a = apply(m, cx, cy);
      const b = apply(m, x, y);
      out.push({ kind, a: [round(a[0]), round(a[1])], b: [round(b[0]), round(b[1])], ...paint });
    }
  };
  const close = () => {
    if (open && (cx !== sx || cy !== sy)) push('L', sx, sy);
    cx = sx;
    cy = sy;
    open = false;
  };
  for (let i = 0; i < data.length;) {
    const op = data[i]!;
    const k = DRAW_ARGS[op];
    if (k === undefined || i + k >= data.length) throw new BadPath();
    // The end point: the last two numbers (none for closePath).
    const x = k ? data[i + k - 1]! : 0;
    const y = k ? data[i + k]! : 0;
    if (op === 0) {
      if (fill) close();
      cx = sx = x;
      cy = sy = y;
      hasPoint = true;
      open = false;
    } else if (op === 4) {
      if (hasPoint) close();
    } else if (!hasPoint) {
      cx = sx = x;
      cy = sy = y;
      hasPoint = true;
    } else {
      push(op === 1 ? 'L' : 'C', x, y);
      cx = x;
      cy = y;
      open = true;
    }
    i += k + 1;
  }
  if (fill) close();
  return n;
}

/**
 * The transforms, relative to the current one, at which an image op paints
 * (each image fills the unit square of its transform). pdfjs's queue
 * optimizer merges runs of `q cm Do Q` into the repeat and group ops. In
 * pdfjs 6 it does not run for `getOperatorList`, but the shapes are read
 * here so that a merged op is never counted once at the wrong place. Data
 * of the wrong shape throws `BadPath`.
 */
function imagePlaces(op: number, a: unknown[] | null, OPS: Pdfjs['OPS']): ArrayLike<number>[] {
  const at = (p: unknown, f: (x: number, y: number) => number[]) => {
    const xy = p as ArrayLike<number> | undefined;
    if (!xy || typeof xy.length !== 'number' || xy.length % 2) throw new BadPath();
    const out: number[][] = [];
    for (let i = 0; i < xy.length; i += 2) out.push(f(xy[i]!, xy[i + 1]!));
    return out;
  };
  const each = (list: unknown) => {
    if (!Array.isArray(list)) throw new BadPath();
    const ms = list.map((x) => (x as { transform?: unknown } | null)?.transform);
    if (!ms.every(isMatrix)) throw new BadPath();
    return ms;
  };
  // [id, scaleX, scaleY, positions]
  if (op === OPS.paintImageXObjectRepeat) {
    const [, sx, sy, p] = (a ?? []) as number[];
    return at(p, (x, y) => [sx!, 0, 0, sy!, x, y]);
  }
  // [id, a, b, c, d, positions]
  if (op === OPS.paintImageMaskXObjectRepeat) {
    const [, m0, m1, m2, m3, p] = (a ?? []) as number[];
    return at(p, (x, y) => [m0!, m1!, m2!, m3!, x, y]);
  }
  // [[{ transform, ... }, ...]]
  if (op === OPS.paintImageMaskXObjectGroup) return each(a?.[0]);
  // [image, [{ transform, ... }, ...]]
  if (op === OPS.paintInlineImageXObjectGroup) return each(a?.[1]);
  return [IDENTITY];
}

// ─── a whole file ─────────────────────────────────────────────────────

export type ReadOptions = WithPdfOptions & {
  budgets?: Budgets;
  /** Pages to read (1-based); all pages when left out. A number listed
   *  twice is read once; one out of range gives a stated `failed` result. */
  pages?: number[];
  /** With no `pages`: read the first `maxPages` pages only. The page count
   *  is a number the file itself declares, so a caller that keeps a result
   *  for each page sets this; `numPages` still gives the declared count, and
   *  the caller states the pages past the cap. */
  maxPages?: number;
};

export type FilePages<T> = {
  /** The page count pdfjs gives. A broken page tree can make it short; see
   *  `pageCountMayBeShort` and the module note. */
  numPages: number;
  /** True when page `numPages` cannot be opened: then pdfjs may have cut
   *  the count at a bad page tree kid, and pages after it have no result.
   *  False does not prove the count: a tree walk that throws gives a count
   *  of 1 that this flag cannot see (module note). */
  pageCountMayBeShort: boolean;
  pages: T[];
};

export type FilePrimitives = FilePages<PagePrimitives>;

/**
 * Open `bytes` with `withPdf` and read the pages asked for, in order. After
 * the first page over the page time budget, or once the file has used
 * `maxFileMs`, every later page is stated `too_large` (time) without being
 * read.
 */
export function readPdfPrimitives(
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<FilePrimitives> {
  return readPdfPages(bytes, opts, (page) => page);
}

/**
 * As {@link readPdfPrimitives}, but each page's result goes through `map`
 * as soon as it is read and only what `map` returns is kept. A caller that
 * needs a few numbers a page so never holds every page's segments at once.
 */
export async function readPdfPages<T>(
  bytes: Uint8Array,
  opts: ReadOptions,
  map: (page: PagePrimitives) => T | Promise<T>,
): Promise<FilePages<T>> {
  const { budgets = DEFAULT_BUDGETS, pages: want, maxPages, ...open } = opts;
  return withPdf(bytes, { verbosity: 0, ...open }, async ({ pdfjs, doc }) => {
    const count = Math.min(doc.numPages, Math.max(1, maxPages ?? doc.numPages));
    const list = [...new Set(want ?? Array.from({ length: count }, (_, i) => i + 1))];
    const fileT0 = Date.now();
    const maxFileMs = budgets.maxFileMs ?? DEFAULT_BUDGETS.maxFileMs;
    // Checked once, whatever pages are asked for. pdfjs already loaded the
    // last page at the open (checkLastPage), so this is quick. It is under
    // the file budget; a time-out sets the flag (the count is not checked).
    const pageCountMayBeShort = await within(doc.getPage(doc.numPages), maxFileMs).then(
      () => false,
      () => true,
    );
    const oc = (await doc.getOptionalContentConfig()) as OcConfig;
    const pages: T[] = [];
    let overTime = false;
    for (const p of list) {
      const fileMs = Date.now() - fileT0;
      let r: PagePrimitives;
      if (!Number.isInteger(p) || p < 1 || p > doc.numPages) {
        r = { page: p, status: 'failed', code: PAGE_OUT_OF_RANGE, ms: 0 };
      } else if (fileMs >= maxFileMs) {
        r = { page: p, status: 'too_large', reason: 'time', limit: maxFileMs, seen: fileMs, ms: 0 };
      } else if (overTime) {
        r = { page: p, status: 'too_large', reason: 'time', limit: budgets.maxMs, seen: 0, ms: 0 };
      } else {
        const t0 = Date.now();
        try {
          const page = await within(doc.getPage(p), budgets.maxMs);
          r = await readPagePrimitives(pdfjs, page, budgets, oc);
        } catch (err) {
          const ms = Date.now() - t0;
          r =
            err instanceof OverTime
              ? { page: p, status: 'too_large', reason: 'time', limit: budgets.maxMs, seen: ms, ms }
              : { page: p, status: 'failed', code: errorCode(err), ms };
        }
        if (r.status === 'too_large' && r.reason === 'time') overTime = true;
      }
      pages.push(await map(r));
    }
    return { numPages: doc.numPages, pageCountMayBeShort, pages };
  });
}

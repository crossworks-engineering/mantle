/**
 * What kind of PDF this is, with no model (plan page 11a16779, section
 * 10.2): page facts from the page primitives, a class a page, a kind a page
 * and one kind a file. Pure functions: no pdfjs, no clock, no I/O.
 *
 * A rule decides only when it is clear. What the rules leave open is
 * `unsure`, and only an unsure file is put to the decider, once
 * (`kindSample` builds the small state it gets). Every threshold is a named
 * constant with the measure it came from; the numbers are counts and
 * shares, never text from a drawing.
 */

import type { PagePrimitives, Segment, TextRun } from './pdf-primitives';
import {
  type InstrumentTag,
  instrumentTagOf,
  listItemsOf,
  parseIsaCode,
  TAG_LIKE,
  TOKEN_MAX_CHARS,
  tokenItems,
  tokensOf,
} from './pdf-tags';

// ─── page facts ───────────────────────────────────────────────────────

export const PAGE_SIZES = ['a4', 'a3', 'a2', 'a1', 'a0', 'larger'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** The ISO sheet a page's long side fits, with about 4% of slack. */
export function pageSizeOf(widthMm: number, heightMm: number): PageSize {
  const long = Math.max(widthMm, heightMm);
  if (long <= 310) return 'a4';
  if (long <= 437) return 'a3';
  if (long <= 618) return 'a2';
  if (long <= 875) return 'a1';
  if (long <= 1237) return 'a0';
  return 'larger';
}

export const PAGE_CLASSES = [
  /** Running text, few lines drawn. */
  'text',
  /** A drawn page with a text layer. */
  'vector_text',
  /** A drawn page whose text is strokes: no text layer. */
  'vector_no_text',
  /** A full-page picture with no text. */
  'scan',
  /** A full-page picture under an invisible text layer (an old OCR pass). */
  'scan_hidden_text',
  /** A full-page picture with a little shown text over it. */
  'raster_with_text',
  /** Almost nothing on the page. */
  'blank',
] as const;
export type PageClass = (typeof PAGE_CLASSES)[number];

/** Share of line length on each axis family, of the lines `AXIS_MIN_MM` long
 *  or longer. `iso` is the two isometric axes, 30 and 150 degrees. */
export type AxisShares = { h: number; v: number; iso: number; other: number; longMm: number };

export type PageFacts = {
  page: number;
  status: 'ok' | 'too_large' | 'failed';
  /** For a page not ok: `segments`, `time`, or the failure code. */
  why?: string;
  widthMm?: number;
  heightMm?: number;
  rotate?: number;
  size?: PageSize;
  class?: PageClass;
  /** Characters in the text runs, spaces left out. */
  chars: number;
  runs: number;
  /** Share of the glyphs drawn in an invisible mode, 0 to 1. */
  hiddenShare: number;
  imageCover: number;
  /** Line and curve segments. On a page over the path budget: the count
   *  seen, with no axes. */
  segments: number;
  axes: AxisShares | null;
  /** Tokens of the wide tag shape (`TAG_LIKE`). */
  tagLike: number;
  /** Instrument tags: an ISA code with its loop number, in one token or as
   *  a code run with a number run under it (a bubble). */
  instruments: number;
  lineNumbers: number;
  /** Markup annotations (widgets left out), and those with text. */
  markups: number;
  markupsWithText: number;
  /** Milliseconds the page reader took for this page. */
  readMs: number;
  /** Fixed labels for what this read left out of an ok page's counts
   *  ({@link PAGE_NOTES}). */
  notes?: PageNote[];
};

/**
 * What a read may leave out of a page's counts, stated on the page:
 * `bubbles_not_paired`: the page holds more code and number runs than the
 * pairing looks at ({@link BUBBLE_MAX_PAIRS}), so `instruments` counts the
 * one-token tags only. `drawn_content_not_read`: the page holds markups, or
 * draws with a pattern, a shading or a Type3 font: this reader does not
 * follow what those draw, so the page can hold more than its counts say.
 * `text_readers_differ`: this reader's character count and pdfjs's own
 * differ by more than {@link TEXT_CHECK_SHARE}, so one of the two lost or
 * added text on this page. `rows_not_listed`: the file holds more rows
 * (words, tags, line numbers, markups), or more characters of word and
 * markup text, than one database lists, and this page's are past the cap. `markups_not_paired`: the page holds more text
 * markups and drawn markups than the pairing looks at, so no markup of it
 * names the drawn markup beside it. `text_outside_page`: the page holds
 * text that lies wholly outside the shown page; it is not in the rows.
 */
export const PAGE_NOTES = [
  'bubbles_not_paired',
  'drawn_content_not_read',
  'text_readers_differ',
  'rows_not_listed',
  'markups_not_paired',
  'text_outside_page',
] as const;
/** The two text readers agree when their character counts are within this
 *  share of each other (and within 5 characters). Bench measure,
 *  2026-11-11: equal to the character on all 118 pages of two sets. */
export const TEXT_CHECK_SHARE = 0.02;
export type PageNote = (typeof PAGE_NOTES)[number];

/** A page with image cover at or over this is a picture of a page. From the
 *  sniff of 2,044 pages (plan 9.6): scans cover the page, and a drawing with
 *  a logo stays far below. */
export const IMAGE_PAGE_COVER = 0.5;
/** A page with this many segments or more is drawn, not typed (plan 9.9). */
export const VECTOR_MIN_SEGMENTS = 1000;
/** Under this many characters a page has no usable text layer. */
export const TEXT_MIN_CHARS = 20;
/** At or over this share of invisible glyphs, the text is a hidden layer
 *  (plan 9.6: an OCR pass under a scan; a vector page stays under 0.21). */
export const HIDDEN_TEXT_SHARE = 0.8;
/** Lines shorter than this are text strokes, hatching and symbols: they say
 *  nothing about the axes of a drawing. */
export const AXIS_MIN_MM = 5;
/** Degrees a line may be off an axis and still count for it. */
export const AXIS_TOLERANCE_DEG = 3;

/** The axis family of a line at `deg` (any angle, degrees). */
export function axisOf(deg: number): 'h' | 'v' | 'iso' | 'other' {
  const a = ((deg % 180) + 180) % 180;
  const near = (x: number) => Math.abs(a - x) <= AXIS_TOLERANCE_DEG;
  if (near(0) || near(180)) return 'h';
  if (near(90)) return 'v';
  if (near(30) || near(150)) return 'iso';
  return 'other';
}

/** Axis shares of straight segments, by length on paper. */
export function axisShares(
  segments: readonly Segment[],
  widthMm: number,
  heightMm: number,
): AxisShares {
  const sum = { h: 0, v: 0, iso: 0, other: 0 };
  for (const s of segments) {
    if (s.kind !== 'L') continue;
    const dx = (s.b[0] - s.a[0]) * widthMm;
    const dy = (s.b[1] - s.a[1]) * heightMm;
    const len = Math.hypot(dx, dy);
    if (len < AXIS_MIN_MM) continue;
    sum[axisOf((Math.atan2(-dy, dx) * 180) / Math.PI)] += len;
  }
  const longMm = sum.h + sum.v + sum.iso + sum.other;
  const share = (v: number) => (longMm > 0 ? Math.round((v / longMm) * 1000) / 1000 : 0);
  return {
    h: share(sum.h),
    v: share(sum.v),
    iso: share(sum.iso),
    other: share(sum.other),
    longMm: Math.round(longMm),
  };
}

/** A loop number. */
const NUMBER_RUN = /^\d{2,6}[A-Z]{0,2}$/;
/** The first loop number of a list: three digits or more, or two with a
 *  letter (`12A/B`), so a date (`11/11`, `12/05/26`) under a word that
 *  reads as a code is no list. */
const LIST_FIRST = /^(?:\d{3,6}[A-Z]{0,2}|\d{2}[A-Z]{1,2})$/;

/**
 * A text run as the grammar reads it: its one token ({@link tokensOf}),
 * or null when the run holds more than one token or one past
 * {@link TOKEN_MAX_CHARS}. The one gateway from a whole run to the
 * grammar, so every pattern reads a bounded token.
 */
export function runToken(t: TextRun): string | null {
  const tokens = tokensOf(t.str);
  return tokens.length === 1 && tokens[0]!.length <= TOKEN_MAX_CHARS ? tokens[0]! : null;
}

/** The loop numbers of a bubble's number token: one, or each item of a
 *  list (`101A/B`, by {@link listItemsOf}); empty when it is no number. */
function loopItems(token: string): string[] {
  const items = listItemsOf(token);
  if (items.length === 0 || !items.every((n) => NUMBER_RUN.test(n))) return [];
  return items.length === 1 || LIST_FIRST.test(items[0]!) ? items : [];
}
/** Degrees a bubble's number may be turned against its code. */
const BUBBLE_ANGLE_DEG = 5;
/**
 * The most code and number pairs one page's pairing looks at (codes times
 * numbers). The pairing compares each code with each number, and it runs
 * after the page's read, outside the page's time budget, so the page's own
 * text must not set its cost. A real sheet stays far below: the fullest
 * P&ID sheet of the bench measure holds about 1,300 text runs in all. A
 * page over it is not paired, and says so (`bubbles_not_paired`).
 */
export const BUBBLE_MAX_PAIRS = 20_000_000;

/**
 * Bubbles: a text run that is only an ISA code, with a run that is only a
 * loop number under it. "Under" is in the frame of the code's own baseline,
 * in millimetres on paper, so a bubble on a turned sheet still pairs: the
 * number's centre lies within half the code's length of the code's centre
 * along the baseline, and from 0.5 to 2.5 text heights below it. One number
 * pairs with one code, the nearest one.
 *
 * Null when the page holds more codes and numbers than `maxPairs`: nothing
 * is paired, and the caller states it.
 */
export function bubblePairs(
  texts: readonly TextRun[],
  widthMm: number,
  heightMm: number,
  maxPairs = BUBBLE_MAX_PAIRS,
): { code: TextRun; number: TextRun }[] | null {
  const codes: TextRun[] = [];
  const numbers: TextRun[] = [];
  for (const t of texts) {
    const s = runToken(t);
    if (!s) continue;
    if (loopItems(s).length > 0) numbers.push(t);
    else if (/^[A-Z]{2,6}$/.test(s) && parseIsaCode(s)) codes.push(t);
  }
  if (codes.length * numbers.length > maxPairs) return null;
  const centre = (t: TextRun): [number, number] => [
    ((t.box[0] + t.box[2]) / 2) * widthMm,
    ((t.box[1] + t.box[3]) / 2) * heightMm,
  ];
  const out: { code: TextRun; number: TextRun }[] = [];
  const used = new Set<TextRun>();
  for (const code of codes) {
    const [cx, cy] = centre(code);
    const rad = (code.angle * Math.PI) / 180;
    // The baseline, and the way down from it, on the page (y grows down).
    const along: [number, number] = [Math.cos(rad), -Math.sin(rad)];
    const down: [number, number] = [Math.sin(rad), Math.cos(rad)];
    const half =
      Math.max((code.box[2] - code.box[0]) * widthMm, (code.box[3] - code.box[1]) * heightMm) / 2;
    const h = code.sizeMm;
    let best: TextRun | null = null;
    let bestDown = Infinity;
    for (const n of numbers) {
      // The turn between the two, with the wrap at 180 degrees taken off.
      const turn = Math.abs(((n.angle - code.angle + 540) % 360) - 180);
      if (used.has(n) || turn > BUBBLE_ANGLE_DEG) continue;
      const [nx, ny] = centre(n);
      const a = (nx - cx) * along[0] + (ny - cy) * along[1];
      const d = (nx - cx) * down[0] + (ny - cy) * down[1];
      if (Math.abs(a) <= half && d >= 0.5 * h && d <= 2.5 * h && d < bestDown) {
        best = n;
        bestDown = d;
      }
    }
    if (best) {
      used.add(best);
      out.push({ code, number: best });
    }
  }
  return out;
}

/**
 * The instrument tags of one bubble: its code with each loop number of its
 * number run (`PSV` over `101A/B` gives `PSV-101A` and `PSV-101B`). Empty
 * when the runs are not one code and one number.
 */
export function bubbleTags(code: TextRun, number: TextRun): InstrumentTag[] {
  const c = runToken(code);
  const n = runToken(number);
  if (!c || !n) return [];
  const tags = loopItems(n).map((item) => instrumentTagOf(c, item));
  return tags.length > 0 && tags.every((t) => t !== null) ? (tags as InstrumentTag[]) : [];
}

/** The class of a page from its counts. */
export function pageClassOf(f: {
  chars: number;
  hiddenShare: number;
  imageCover: number;
  segments: number;
}): PageClass {
  const hasText = f.chars >= TEXT_MIN_CHARS;
  if (f.imageCover >= IMAGE_PAGE_COVER) {
    if (!hasText) return 'scan';
    return f.hiddenShare >= HIDDEN_TEXT_SHARE ? 'scan_hidden_text' : 'raster_with_text';
  }
  if (f.segments >= VECTOR_MIN_SEGMENTS) return hasText ? 'vector_text' : 'vector_no_text';
  return hasText ? 'text' : 'blank';
}

/** The facts of one page, from what the page reader gave. */
export function pageFacts(p: PagePrimitives): PageFacts {
  const readMs = p.status === 'ok' ? p.stats.ms : p.ms;
  const none = {
    chars: 0,
    runs: 0,
    hiddenShare: 0,
    imageCover: 0,
    segments: 0,
    axes: null,
    tagLike: 0,
    instruments: 0,
    lineNumbers: 0,
    markups: 0,
    markupsWithText: 0,
    readMs,
  };
  if (p.status === 'failed') return { page: p.page, status: 'failed', why: p.code, ...none };
  const frame =
    'widthMm' in p
      ? {
          widthMm: p.widthMm,
          heightMm: p.heightMm,
          rotate: p.rotate,
          size: pageSizeOf(p.widthMm, p.heightMm),
        }
      : {};
  if (!('widthMm' in p) || !p.texts || !p.annotations || !p.stats) {
    return {
      page: p.page,
      status: 'too_large',
      why: p.status === 'too_large' ? p.reason : '',
      ...frame,
      ...none,
    };
  }
  let chars = 0;
  let tagLike = 0;
  let instruments = 0;
  let lineNumbers = 0;
  for (const t of p.texts) {
    for (const token of tokensOf(t.str)) {
      chars += token.length;
      if (TAG_LIKE.test(token)) tagLike++;
      // A token with a list counts a tag an item, as its rows do.
      const read = tokenItems(token);
      if (read?.kind === 'instrument') instruments += read.items.length;
      else if (read?.kind === 'line') lineNumbers += read.items.length;
    }
  }
  const bubbles = bubblePairs(p.texts, p.widthMm, p.heightMm);
  for (const { code, number } of bubbles ?? []) {
    instruments += bubbleTags(code, number).length;
  }
  const notes: PageNote[] = [];
  if (bubbles === null) notes.push('bubbles_not_paired');
  if (p.stats.notWalked > 0) notes.push('drawn_content_not_read');
  if (p.stats.outsideFrame.texts > 0) notes.push('text_outside_page');
  const { own, pdfjs } = p.stats.textCheck;
  if (Math.abs(own - pdfjs) > Math.max(5, TEXT_CHECK_SHARE * Math.max(own, pdfjs))) {
    notes.push('text_readers_differ');
  }
  const markups = p.annotations.filter((a) => a.kind !== 'Widget');
  const segments = p.status === 'ok' ? p.segments.length : p.seen;
  const counts = {
    chars,
    hiddenShare:
      p.stats.glyphs > 0 ? Math.round((p.stats.hiddenGlyphs / p.stats.glyphs) * 1000) / 1000 : 0,
    imageCover: p.stats.imageCover,
    segments,
  };
  return {
    page: p.page,
    status: p.status,
    ...(p.status === 'too_large' ? { why: p.reason } : {}),
    ...frame,
    class: pageClassOf(counts),
    ...counts,
    runs: p.texts.length,
    axes: p.status === 'ok' ? axisShares(p.segments, p.widthMm, p.heightMm) : null,
    tagLike,
    instruments,
    lineNumbers,
    markups: markups.length,
    markupsWithText: markups.filter((a) => a.text.trim()).length,
    readMs,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ─── the eye: what a picture of a raster page shows ───────────────────

/** What the OpenCV step gives for a page's picture
 *  (server/parser/cad/pdf_eye.py). */
export type PageEye = {
  axes: AxisShares;
  skewDeg: number;
  /** Share of the picture that is ink, 0 to 1. */
  ink: number;
  textAreas: number;
};

// ─── kinds ────────────────────────────────────────────────────────────

/** What a page is, by the rules. `none`: the page could not be read. */
export const PAGE_KINDS = [
  'pid',
  'isometric',
  'scan',
  'other_drawing',
  'document',
  'unsure',
  'none',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * What a file is. The rules give `pid`, `isometric`, `scan` (a scanned
 * drawing or form whose kind is not known), `other_drawing`, `document` and
 * `unsure`; the decider may also answer `pfd`, `equipment_drawing`,
 * `datasheet` and `table` (rows of data: an invoice, a list) for an unsure
 * file.
 */
export const PDF_KINDS = [
  'pid',
  'pfd',
  'isometric',
  'equipment_drawing',
  'datasheet',
  'table',
  'scan',
  'other_drawing',
  'document',
  'unsure',
] as const;
export type PdfKind = (typeof PDF_KINDS)[number];

/**
 * The P&ID rule: a drawn page with text, larger than an A4 sheet, with this many
 * line numbers, or this many instrument tags. Bench measure, 2026-11-11:
 * of 35 real P&ID sheets 32 pass (the other 3 hold almost no tags: cover
 * and legend sheets, left unsure); of 83 equipment drawings none passes
 * (most line numbers on one: 1; most instrument tags: 42).
 */
export const PID_MIN_LINE_NUMBERS = 3;
export const PID_MIN_INSTRUMENTS = 60;
/**
 * The isometric rule: at least this share of the long-line length runs on
 * the 30 and 150 degree axes, and more than on all the other slanted
 * directions. It is a clear-case rule only. Bench measure, 2026-11-11: P&ID
 * pages reach 0.025; isometric sketch sheets that are mostly a ruled form
 * give 0.02 to 0.17, so most of them stay `scan`.
 */
export const ISO_MIN_SHARE = 0.1;
/**
 * A raster page on an office sheet (A4 paper or an A3 sheet) is a drawing or a ruled
 * form, not a typed page, when its long lines add up to this length for each
 * A4 sheet of paper. A raster page on a larger sheet is a drawing whatever
 * its lines (bench measure: a plotted sheet 5 m long has few lines for its
 * area). Bench measure,
 * 2026-11-11, 4 scanned sketches on A4 paper: 2,900 to 10,400 mm.
 */
export const SCAN_DRAWING_MIN_LINE_MM_PER_A4 = 2000;
const A4_MM2 = 210 * 297;

const isoClear = (a: AxisShares | null) => !!a && a.iso >= ISO_MIN_SHARE && a.iso > a.other;

/** True when a page's long lines reach the ruled-form floor for its paper
 *  (`SCAN_DRAWING_MIN_LINE_MM_PER_A4`). */
const ruled = (f: PageFacts, axes: AxisShares) =>
  axes.longMm >=
  SCAN_DRAWING_MIN_LINE_MM_PER_A4 * (((f.widthMm ?? 210) * (f.heightMm ?? 297)) / A4_MM2);

/**
 * The kind of one page. A raster page (a scan, a scan with hidden text, a
 * picture with a little text) on a sheet larger than A3 is a `scan`. On an
 * office sheet it needs its `eye`; without one it is `rasterDefault` (what
 * the reader's looked-at raster pages of the file say), else `unsure`.
 *
 * A drawn page with no text layer on an office sheet is a drawing only
 * with the long lines of one: a typed page whose letters were turned into
 * outlines is drawn too, and is all short curves. The same floor as for a
 * scanned office page; under it the page is `unsure`.
 */
export function pageKindOf(
  f: PageFacts,
  eye: PageEye | null = null,
  rasterDefault: PageKind | null = null,
): PageKind {
  if (!f.class) return 'none';
  switch (f.class) {
    case 'text':
    case 'blank':
      // A page that reads as empty while it draws content this reader does
      // not follow is not known to be empty.
      if (f.class === 'blank' && f.notes?.includes('drawn_content_not_read')) return 'unsure';
      // A typed page is an office sheet. A large sheet with little on it is
      // more likely a drawing whose picture or lines did not count.
      return f.size === 'a4' || f.size === 'a3' ? 'document' : 'unsure';
    case 'vector_text':
      return f.size !== 'a4' &&
        (f.lineNumbers >= PID_MIN_LINE_NUMBERS || f.instruments >= PID_MIN_INSTRUMENTS)
        ? 'pid'
        : 'unsure';
    case 'vector_no_text': {
      if (isoClear(f.axes)) return 'isometric';
      // No axes: a page over the path budget, which is more than a page of
      // outlined letters holds.
      const office = f.size === 'a4' || f.size === 'a3';
      return !office || !f.axes || ruled(f, f.axes) ? 'other_drawing' : 'unsure';
    }
    default: {
      // A picture on a sheet larger than an office page is a drawing, seen
      // or not: the eye and the other pages only tell a scanned letter from
      // a scanned form, and that question is for an office page.
      const large = f.size !== 'a4' && f.size !== 'a3';
      if (!eye) return large ? 'scan' : (rasterDefault ?? 'unsure');
      if (isoClear(eye.axes)) return 'isometric';
      if (large) return 'scan';
      return ruled(f, eye.axes) ? 'scan' : 'document';
    }
  }
}

/**
 * The file's kind from its pages' kinds: the first of these that a page
 * has. One drawing page makes the file a drawing. A file is a `document`
 * only when no page says more AND the reader left nothing out: `allRead`,
 * the caller's ONE fact for that (`readPdfDrawing`: every page has a row,
 * every row was read whole, no image was too large to open). What the
 * reader left out may be the drawing, so the file is `unsure`: it then gets
 * its database, where what was left out is stated; a document gets none, so
 * nothing could state it.
 */
const FILE_KIND_ORDER = [
  'pid',
  'isometric',
  'scan',
  'other_drawing',
  'unsure',
  'document',
] as const;

export function fileKindOf(pageKinds: readonly PageKind[], allRead: boolean): PdfKind {
  for (const kind of FILE_KIND_ORDER) {
    if (!pageKinds.includes(kind)) continue;
    return kind === 'document' && !allRead ? 'unsure' : kind;
  }
  // No page could be read: nothing says what the file is.
  return 'unsure';
}

/** True for a page class that is a picture of a page: its kind needs the eye. */
export function isRasterClass(c: PageClass | undefined): boolean {
  return c === 'scan' || c === 'scan_hidden_text' || c === 'raster_with_text';
}

// ─── the text sample for the decider ──────────────────────────────────

/** Characters of text an unsure file sends to the decider, at most. */
export const KIND_SAMPLE_MAX_CHARS = 1500;

/**
 * A small text sample of one page for the decider: first the text in the
 * lower right corner, where a drawing's title block sits (60% of the
 * characters at most), then the words the page uses most. White space is
 * collapsed. The page's hidden text is in it when the reader cannot tell
 * (`textMayIncludeHidden`): it is a hint for a choice, not data.
 */
export function kindSample(texts: readonly TextRun[], maxChars = KIND_SAMPLE_MAX_CHARS): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const corner: string[] = [];
  let used = 0;
  const cornerMax = Math.floor(maxChars * 0.6);
  for (const t of texts) {
    const x = (t.box[0] + t.box[2]) / 2;
    const y = (t.box[1] + t.box[3]) / 2;
    if (x < 0.6 || y < 0.75) continue;
    const s = clean(t.str);
    if (!s || used + s.length + 1 > cornerMax) continue;
    corner.push(s);
    used += s.length + 1;
  }
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const w of clean(t.str).toUpperCase().split(' ')) {
      if (/^\p{L}{3,}$/u.test(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const words: string[] = [];
  // Most used first; ties in alphabetical order, so the sample is the same
  // on every read of the same page.
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [w] of ranked) {
    if (used + w.length + 1 > maxChars) break;
    words.push(w);
    used += w.length + 1;
  }
  return clean(`${corner.join(' ')} ${words.join(' ')}`);
}

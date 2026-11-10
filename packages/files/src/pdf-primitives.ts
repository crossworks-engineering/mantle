/**
 * Page primitives from a PDF drawing, read with pdfjs-dist through the one
 * opener (`withPdf`). Phase 0 of the PDF drawing plan (dev-brain page
 * 11a16779, sections 4, 9.2 G3 and G7, 9.3): a test of the library, not the
 * engine. No route, tool or ingest path imports this module.
 *
 * Per page it gives, in ONE coordinate frame:
 *
 *  - origin at the top left of the page as it is shown, x to the right, y
 *    down; units a fraction of the shown width (x) and height (y). The page
 *    rotation, the CropBox and the UserUnit are applied (pdfjs's viewport
 *    holds all three), so the same spot on two sheets has the same numbers
 *    whatever frame each sheet was written in;
 *  - text runs (pdfjs `getTextContent` items) with an axis-aligned box and
 *    the angle of the baseline on the shown page, in degrees counterclockwise;
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
 * Hidden text: pdfjs's text content does not say which run was drawn in an
 * invisible render mode (3 or 7) or in optional content that is off, so
 * those runs still come through in `texts`. The ok result has ONE flag for
 * this, `textMayIncludeHidden`. A caller must check that field before it
 * trusts `texts` as shown text. (Phase 1 reads glyphs from the operator
 * list and gets a flag per run there.)
 *
 * Budgets: a page with more segments than `maxSegments`, or that takes
 * longer than `maxMs`, returns `{ status: 'too_large' }` with the reason and
 * the count. It never returns a part of the page as if it were the whole.
 * pdfjs cannot be stopped, so after the first page over time, a file's later
 * pages are stated `too_large` (time) without being read. A file also has
 * its own time budget, `maxFileMs`, checked before each page: once the file
 * has used it, the later pages are stated `too_large` (time) with that
 * limit. A file can so run over `maxFileMs` by about one page's `maxMs`.
 *
 * Known limits of what pdfjs gives here (phase 0 findings, see the tests):
 * a text run is a pdfjs item, not a word, and it has no per-glyph boxes;
 * hidden text is a page count (`hiddenGlyphs`, `ocHiddenGlyphs`) and the
 * one flag above, not a flag per run; vertical writing-mode fonts are
 * counted (`verticalRuns`), not handled (rotated text is). Drawn content
 * that this walk does not follow (tiling-pattern cells, shading fills,
 * Type3 glyph drawings) is counted (`notWalked`), not read. Segments and
 * annotations wholly outside the shown page are kept and counted
 * (`outsideFrame`); pdfjs's text content already leaves out text runs
 * placed outside the page.
 */

import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { withPdf, type WithPdfOptions } from './pdf-open';

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** x0, y0, x1, y1 in the page frame (fractions; x0 <= x1, y0 <= y1). */
export type Box = [number, number, number, number];

export type TextRun = {
  str: string;
  box: Box;
  /** Baseline angle on the shown page, degrees counterclockwise, (-180, 180]. */
  angle: number;
  /** Font size on paper, in millimetres. */
  sizeMm: number;
  /** pdfjs's font id (a loaded-font name, not the PDF's BaseFont). */
  font: string;
};

/** A drawn line (`L`) or curve (`C`, end points only), from a to b. */
export type Segment = { kind: 'L' | 'C'; a: [number, number]; b: [number, number] };

export type Annotation = { kind: string; text: string; box: Box };

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
  /** Ops that draw content this walk does not follow, so their lines are
   *  not in `segments`: a tiling pattern set as a colour (its cell), a
   *  shading fill, and text shown in a Type3 font (its glyph drawings). */
  notWalked: number;
  /** Text runs in a vertical writing-mode font (their boxes are not right). */
  verticalRuns: number;
  /** Items kept whose box is wholly outside the shown page (0..1). Text
   *  runs are not here: pdfjs leaves out runs placed outside the page. */
  outsideFrame: { segments: number; annotations: number };
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
      reason: 'segments' | 'time';
      /** The budget that was passed. */
      limit: number;
      /** Segments counted (reason segments) or ms spent (reason time). For
       *  a page skipped because an earlier page was over time: 0. For a page
       *  skipped because the file was over `maxFileMs`: the file's ms so far
       *  (and `limit` is `maxFileMs`). */
      seen: number;
      ms: number;
    })
  | (Head & { status: 'failed'; code: string; ms: number });

/** Fixed failure codes of the reader itself. */
export const PAGE_OUT_OF_RANGE = 'page_out_of_range';

export type Budgets = {
  maxSegments: number;
  /** Time for one page. */
  maxMs: number;
  /** Time for the whole file, checked before each page. Default 300,000 ms. */
  maxFileMs?: number;
};

/**
 * Defaults from the phase 0 sample (plan 9.6): the P&ID class has a median of
 * about 32,000 segments a page; 10 of 2,044 pages hold more than 100,000 and
 * one holds 6.0 million. The file budget, 5 minutes, is 10 pages at the full
 * page budget; the measured median page took about 0.15 s.
 */
export const DEFAULT_BUDGETS: Required<Budgets> = {
  maxSegments: 250_000,
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
  if (ms <= 0) return Promise.reject(new OverTime());
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
    const fn = ol.fnArray;
    const args = ol.argsArray as unknown[];
    // Graphics state saved by q and by a form: transform, render mode, font.
    const stack: [M, number, string][] = [];
    // Stack depth just after each open form's own save. A restore at or
    // below it is a stray Q in the form: it must not pop the form's save.
    const forms: number[] = [];
    let ctm: M = IDENTITY;
    let mode = 0;
    let font = '';
    // Text ops per font id, to count the Type3 ones once the fonts are known.
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
    for (let k = 0; k < fn.length; k++) {
      const op = fn[k];
      const a = args[k] as unknown[] | null;
      if (op === OPS.save) stack.push([ctm, mode, font]);
      else if (op === OPS.restore) {
        if (stack.length > (forms.at(-1) ?? 0)) [ctm, mode, font] = stack.pop()!;
      } else if (op === OPS.transform) {
        if (a && a.length >= 6) ctm = mul(ctm, a as number[]);
      } else if (op === OPS.paintFormXObjectBegin) {
        stack.push([ctm, mode, font]);
        forms.push(stack.length);
        if (a && isMatrix(a[0])) ctm = mul(ctm, a[0]);
      } else if (op === OPS.paintFormXObjectEnd) {
        // Saves the form left open are dropped with it.
        const depth = forms.pop();
        if (depth !== undefined && stack.length > depth) stack.length = depth;
        const s = stack.pop();
        if (s) [ctm, mode, font] = s;
      } else if (op === OPS.setFont) {
        font = String(a?.[0] ?? '');
      } else if (op === OPS.shadingFill) {
        if (ocOff === 0) notWalked++;
      } else if (op === OPS.setFillColorN || op === OPS.setStrokeColorN) {
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
        mode = Number(a?.[0]) || 0;
      } else if (op === OPS.constructPath) {
        // [paint op, [Float32Array path data], minMax]; a clip-only path
        // ends with endPath and draws nothing.
        if (!a || a[0] === OPS.endPath) continue;
        const holder = a[1] as ArrayLike<unknown> | undefined;
        const data = holder?.[0] as ArrayLike<number> | null | undefined;
        if (!data || typeof data.length !== 'number') continue;
        const m = mul(toFrame, ctm);
        const fill = fillOps.has(a[0] as number);
        if (ocOff > 0) {
          ocHiddenSegments += addSegments(data, m, segments, 0, fill);
          continue;
        }
        paths++;
        counted += addSegments(
          data,
          m,
          segments,
          counted < budgets.maxSegments ? budgets.maxSegments - counted : 0,
          fill,
        );
      } else if (imageOps.has(op!)) {
        if (ocOff > 0) {
          ocHiddenImages++;
          continue;
        }
        // An image fills the unit square of its transform.
        for (const place of imagePlaces(op!, a, OPS)) {
          const m = mul(mul(toFrame, ctm), place);
          const b = boxOf([apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]);
          const w = Math.max(0, Math.min(1, b[2]) - Math.max(0, b[0]));
          const h = Math.max(0, Math.min(1, b[3]) - Math.max(0, b[1]));
          imageCover += w * h;
        }
      } else if (textOps.has(op!)) {
        const arr = Array.isArray(a?.[0]) ? (a[0] as unknown[]) : [];
        let g = 0;
        for (const x of arr) if (x && typeof x === 'object') g++;
        glyphs += g;
        if (mode === 3 || mode === 7) hiddenGlyphs += g;
        if (ocOff > 0) ocHiddenGlyphs += g;
        else textOpsByFont.set(font, (textOpsByFont.get(font) ?? 0) + 1);
      }
    }
    // Type3 glyphs are drawings of their own (the font's char procs), which
    // this walk does not follow. A font that fails to load counts as not Type3.
    for (const [id, n] of textOpsByFont) {
      if (!id) continue;
      const f = await within(new Promise<unknown>((res) => page.commonObjs.get(id, res)), left());
      if ((f as { isType3Font?: boolean } | null)?.isType3Font) notWalked += n;
    }
    if (counted > budgets.maxSegments) {
      page.cleanup();
      return {
        ...shown,
        status: 'too_large',
        reason: 'segments',
        limit: budgets.maxSegments,
        seen: counted,
        ms: Date.now() - t0,
      };
    }
    let segmentsOutside = 0;
    for (const s of segments) if (outsideFrame(boxOf([s.a, s.b]))) segmentsOutside++;

    // ── text ──
    const tc = await within(page.getTextContent(), left());
    const texts: TextRun[] = [];
    const mmPerUser = (25.4 / 72) * userUnit;
    let verticalRuns = 0;
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;
      const tr = it.transform as number[];
      const len = Math.hypot(tr[0]!, tr[1]!) || 1;
      const upLen = Math.hypot(tr[2]!, tr[3]!) || 1;
      const ux = tr[0]! / len;
      const uy = tr[1]! / len;
      const vx = (tr[2]! / upLen) * it.height;
      const vy = (tr[3]! / upLen) * it.height;
      const ox = tr[4]!;
      const oy = tr[5]!;
      const ex = ox + ux * it.width;
      const ey = oy + uy * it.width;
      const corners: [number, number][] = [
        apply(toFrame, ox, oy),
        apply(toFrame, ex, ey),
        apply(toFrame, ex + vx, ey + vy),
        apply(toFrame, ox + vx, oy + vy),
      ];
      // The baseline direction on the shown page: in page units, not
      // fractions, so a non-square page does not skew the angle.
      const p0 = apply(vp.transform as M, ox, oy);
      const p1 = apply(vp.transform as M, ox + ux, oy + uy);
      let angle = (Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]) * 180) / Math.PI;
      if (angle <= -180) angle += 360;
      if (tc.styles[it.fontName]?.vertical) verticalRuns++;
      texts.push({
        str: it.str,
        box: boxOf(corners),
        angle: Math.round(angle * 100) / 100 + 0, // + 0: no -0
        sizeMm: Math.round(it.height * mmPerUser * 1000) / 1000,
        font: it.fontName,
      });
    }

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
          : String(an.contentsObj?.str ?? '');
      const box = boxOf([
        apply(toFrame, r[0]!, r[1]!),
        apply(toFrame, r[2]!, r[1]!),
        apply(toFrame, r[2]!, r[3]!),
        apply(toFrame, r[0]!, r[3]!),
      ]);
      if (outsideFrame(box)) annotationsOutside++;
      annotations.push({ kind, text, box });
    }
    page.cleanup();
    if (left() < 0) return overTime();
    return {
      ...shown,
      status: 'ok',
      textMayIncludeHidden: hiddenGlyphs + ocHiddenGlyphs > 0,
      texts,
      segments,
      annotations,
      stats: {
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
        outsideFrame: {
          segments: segmentsOutside,
          annotations: annotationsOutside,
        },
        ms: Date.now() - t0,
      },
    };
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
 * unknown op code or data cut short throws `BadPath`.
 */
function addSegments(
  data: ArrayLike<number>,
  m: M,
  out: Segment[],
  room: number,
  fill: boolean,
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
      out.push({ kind, a: [round(a[0]), round(a[1])], b: [round(b[0]), round(b[1])] });
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
};

/**
 * Open `bytes` with `withPdf` and read the pages asked for, in order. After
 * the first page over the page time budget, or once the file has used
 * `maxFileMs`, every later page is stated `too_large` (time) without being
 * read.
 */
export async function readPdfPrimitives(
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<{ numPages: number; pages: PagePrimitives[] }> {
  const { budgets = DEFAULT_BUDGETS, pages: want, ...open } = opts;
  return withPdf(bytes, { verbosity: 0, ...open }, async ({ pdfjs, doc }) => {
    const list = [...new Set(want ?? Array.from({ length: doc.numPages }, (_, i) => i + 1))];
    const fileT0 = Date.now();
    const maxFileMs = budgets.maxFileMs ?? DEFAULT_BUDGETS.maxFileMs;
    const oc = (await doc.getOptionalContentConfig()) as OcConfig;
    const pages: PagePrimitives[] = [];
    let overTime = false;
    for (const p of list) {
      const fileMs = Date.now() - fileT0;
      if (!Number.isInteger(p) || p < 1 || p > doc.numPages) {
        pages.push({ page: p, status: 'failed', code: PAGE_OUT_OF_RANGE, ms: 0 });
      } else if (fileMs >= maxFileMs) {
        pages.push({
          page: p,
          status: 'too_large',
          reason: 'time',
          limit: maxFileMs,
          seen: fileMs,
          ms: 0,
        });
      } else if (overTime) {
        pages.push({
          page: p,
          status: 'too_large',
          reason: 'time',
          limit: budgets.maxMs,
          seen: 0,
          ms: 0,
        });
      } else {
        const t0 = Date.now();
        let r: PagePrimitives;
        try {
          r = await readPagePrimitives(pdfjs, await doc.getPage(p), budgets, oc);
        } catch (err) {
          r = { page: p, status: 'failed', code: errorCode(err), ms: Date.now() - t0 };
        }
        if (r.status === 'too_large' && r.reason === 'time') overTime = true;
        pages.push(r);
      }
    }
    return { numPages: doc.numPages, pages };
  });
}

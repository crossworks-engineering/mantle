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
 *  - line and curve segments with their end points (`getOperatorList`, with
 *    the current transform tracked through save, restore, transform and form
 *    XObjects); clip-only paths are left out;
 *  - annotations (`getAnnotations`) with kind, text and box; Link and Popup
 *    are left out (a Popup repeats its parent's text).
 *
 * Budgets: a page with more segments than `maxSegments`, or that takes
 * longer than `maxMs`, returns `{ status: 'too_large' }` with the reason and
 * the count. It never returns a part of the page as if it were the whole.
 *
 * Known limits of what pdfjs gives here (phase 0 findings, see the tests):
 * a text run is a pdfjs item, not a word, and it has no per-glyph boxes;
 * pdfjs does not say which item was drawn in an invisible render mode, so
 * hidden text is a page count (`hiddenGlyphs`), not a flag per run; vertical
 * writing-mode fonts are not handled (rotated text is).
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
  /** Share of the page covered by painted images (box area, clamped, summed, max 1). */
  imageCover: number;
  /** Paths with fill or stroke, and the segments in them. */
  paths: number;
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

export type PagePrimitives =
  | (PageFrame & {
      status: 'ok';
      texts: TextRun[];
      segments: Segment[];
      annotations: Annotation[];
      stats: PageStats;
    })
  | (PageFrame & {
      status: 'too_large';
      reason: 'segments' | 'time';
      /** The budget that was passed. */
      limit: number;
      /** Segments counted (reason segments) or ms spent (reason time). */
      seen: number;
      ms: number;
    })
  | (PageFrame & { status: 'failed'; code: string; ms: number });

export type Budgets = { maxSegments: number; maxMs: number };

/**
 * Defaults from the phase 0 sample (plan 9.6): the P&ID class has a median of
 * about 32,000 segments a page; 10 of 2,044 pages hold more than 100,000 and
 * one holds 6.0 million.
 */
export const DEFAULT_BUDGETS: Budgets = { maxSegments: 250_000, maxMs: 30_000 };

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

/** Error names that may leave a box: fixed labels, never a message. */
const KNOWN_ERRORS = new Set([
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

/**
 * Read one page. `pdfjs` is the module `withPdf` hands its callback (for
 * `OPS`). Never throws for a page fault: it returns `status: 'failed'` with
 * a fixed error label.
 */
export async function readPagePrimitives(
  pdfjs: Pdfjs,
  page: PDFPageProxy,
  budgets: Budgets = DEFAULT_BUDGETS,
): Promise<PagePrimitives> {
  const t0 = Date.now();
  const left = () => budgets.maxMs - (Date.now() - t0);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width;
  const H = vp.height;
  // User space to the page frame: the viewport (rotation, CropBox origin,
  // UserUnit, y flip), then divide by the shown size.
  const toFrame: M = mul([1 / W, 0, 0, 1 / H, 0, 0], vp.transform);
  const userUnit = Number(page.userUnit) || 1;
  const frame: PageFrame = {
    page: page.pageNumber,
    widthMm: round((W / 72) * 25.4),
    heightMm: round((H / 72) * 25.4),
    rotate: Number(page.rotate) || 0,
    userUnit,
  };
  const overTime = (): PagePrimitives => ({
    ...frame,
    status: 'too_large',
    reason: 'time',
    limit: budgets.maxMs,
    seen: Date.now() - t0,
    ms: Date.now() - t0,
  });

  try {
    // ── paths, images, render modes ──
    const ol = await within(page.getOperatorList(), left());
    const OPS = pdfjs.OPS;
    const imageOps = new Set(
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintImageXObjectRepeat,
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
    const fn = ol.fnArray;
    const args = ol.argsArray as unknown[];
    const stack: [M, number][] = [];
    let ctm: M = IDENTITY;
    let mode = 0;
    let glyphs = 0;
    let hiddenGlyphs = 0;
    let imageCover = 0;
    let paths = 0;
    let counted = 0;
    const segments: Segment[] = [];
    for (let k = 0; k < fn.length; k++) {
      const op = fn[k];
      const a = args[k] as unknown[] | null;
      if (op === OPS.save) stack.push([ctm, mode]);
      else if (op === OPS.restore) {
        const s = stack.pop();
        if (s) [ctm, mode] = s;
      } else if (op === OPS.transform) {
        if (a && a.length >= 6) ctm = mul(ctm, a as number[]);
      } else if (op === OPS.paintFormXObjectBegin) {
        stack.push([ctm, mode]);
        if (a && isMatrix(a[0])) ctm = mul(ctm, a[0]);
      } else if (op === OPS.paintFormXObjectEnd) {
        const s = stack.pop();
        if (s) [ctm, mode] = s;
      } else if (op === OPS.setTextRenderingMode) {
        mode = Number(a?.[0]) || 0;
      } else if (op === OPS.constructPath) {
        // [paint op, [Float32Array path data], minMax]; a clip-only path
        // ends with endPath and draws nothing.
        if (!a || a[0] === OPS.endPath) continue;
        const holder = a[1] as ArrayLike<unknown> | undefined;
        const data = holder?.[0] as ArrayLike<number> | null | undefined;
        if (!data || typeof data.length !== 'number') continue;
        paths++;
        const m = mul(toFrame, ctm);
        counted += addSegments(
          data,
          m,
          segments,
          counted < budgets.maxSegments ? budgets.maxSegments - counted : 0,
        );
      } else if (imageOps.has(op!)) {
        // An image fills the unit square of the current transform.
        const m = mul(toFrame, ctm);
        const b = boxOf([apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]);
        const w = Math.max(0, Math.min(1, b[2]) - Math.max(0, b[0]));
        const h = Math.max(0, Math.min(1, b[3]) - Math.max(0, b[1]));
        imageCover += w * h;
      } else if (textOps.has(op!)) {
        const arr = Array.isArray(a?.[0]) ? (a[0] as unknown[]) : [];
        let g = 0;
        for (const x of arr) if (x && typeof x === 'object') g++;
        glyphs += g;
        if (mode === 3 || mode === 7) hiddenGlyphs += g;
      }
    }
    if (counted > budgets.maxSegments) {
      page.cleanup();
      return {
        ...frame,
        status: 'too_large',
        reason: 'segments',
        limit: budgets.maxSegments,
        seen: counted,
        ms: Date.now() - t0,
      };
    }

    // ── text ──
    const tc = await within(page.getTextContent(), left());
    const texts: TextRun[] = [];
    const mmPerUser = (25.4 / 72) * userUnit;
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
      texts.push({
        str: it.str,
        box: boxOf(corners),
        angle: Math.round(angle * 100) / 100 + 0, // + 0: no -0
        sizeMm: Math.round(it.height * mmPerUser * 1000) / 1000,
        font: it.fontName,
      });
    }

    // ── annotations ──
    const annots = (await within(page.getAnnotations(), left())) as {
      subtype?: string;
      rect?: number[];
      contentsObj?: { str?: string };
      fieldValue?: unknown;
    }[];
    const annotations: Annotation[] = [];
    for (const an of annots) {
      const kind = String(an?.subtype ?? '');
      if (!kind || kind === 'Link' || kind === 'Popup') continue;
      const r = an.rect ?? [0, 0, 0, 0];
      const fv = an.fieldValue;
      const text =
        kind === 'Widget'
          ? Array.isArray(fv)
            ? fv.join('')
            : fv == null
              ? ''
              : String(fv)
          : String(an.contentsObj?.str ?? '');
      annotations.push({
        kind,
        text,
        box: boxOf([
          apply(toFrame, r[0]!, r[1]!),
          apply(toFrame, r[2]!, r[1]!),
          apply(toFrame, r[2]!, r[3]!),
          apply(toFrame, r[0]!, r[3]!),
        ]),
      });
    }
    page.cleanup();
    if (left() < 0) return overTime();
    return {
      ...frame,
      status: 'ok',
      texts,
      segments,
      annotations,
      stats: {
        glyphs,
        hiddenGlyphs,
        imageCover: Math.round(Math.min(1, imageCover) * 1000) / 1000,
        paths,
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

/**
 * Walk one path's data (pdfjs 6 DrawOPS: 0 moveTo x y, 1 lineTo x y,
 * 2 curveTo x1 y1 x2 y2 x y, 3 quadraticCurveTo x1 y1 x y, 4 closePath),
 * push up to `room` segments in the page frame, and return how many it
 * counted (all of them, also past `room`, so a page over budget can say by
 * how much).
 */
function addSegments(data: ArrayLike<number>, m: M, out: Segment[], room: number): number {
  let n = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const push = (kind: 'L' | 'C', x: number, y: number) => {
    n++;
    if (n <= room) {
      const a = apply(m, cx, cy);
      const b = apply(m, x, y);
      out.push({ kind, a: [round(a[0]), round(a[1])], b: [round(b[0]), round(b[1])] });
    }
  };
  for (let i = 0; i < data.length;) {
    const op = data[i];
    if (op === 0) {
      cx = sx = data[i + 1]!;
      cy = sy = data[i + 2]!;
      i += 3;
    } else if (op === 1) {
      push('L', data[i + 1]!, data[i + 2]!);
      cx = data[i + 1]!;
      cy = data[i + 2]!;
      i += 3;
    } else if (op === 2) {
      push('C', data[i + 5]!, data[i + 6]!);
      cx = data[i + 5]!;
      cy = data[i + 6]!;
      i += 7;
    } else if (op === 3) {
      push('C', data[i + 3]!, data[i + 4]!);
      cx = data[i + 3]!;
      cy = data[i + 4]!;
      i += 5;
    } else if (op === 4) {
      if (cx !== sx || cy !== sy) push('L', sx, sy);
      cx = sx;
      cy = sy;
      i += 1;
    } else {
      break; // an unknown layout: stop rather than misread the numbers
    }
  }
  return n;
}

// ─── a whole file ─────────────────────────────────────────────────────

export type ReadOptions = WithPdfOptions & {
  budgets?: Budgets;
  /** Pages to read (1-based); all pages when left out. */
  pages?: number[];
};

/** Open `bytes` with `withPdf` and read the pages asked for, in order. */
export async function readPdfPrimitives(
  bytes: Uint8Array,
  opts: ReadOptions = {},
): Promise<{ numPages: number; pages: PagePrimitives[] }> {
  const { budgets = DEFAULT_BUDGETS, pages: want, ...open } = opts;
  return withPdf(bytes, { verbosity: 0, ...open }, async ({ pdfjs, doc }) => {
    const list = want ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const pages: PagePrimitives[] = [];
    for (const p of list) {
      if (p < 1 || p > doc.numPages) continue;
      pages.push(await readPagePrimitives(pdfjs, await doc.getPage(p), budgets));
    }
    return { numPages: doc.numPages, pages };
  });
}

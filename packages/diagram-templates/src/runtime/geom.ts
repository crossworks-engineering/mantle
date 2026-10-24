/**
 * Boxes, segments and the layout self-check. The QA pass reads the finished
 * geometry and reports what a reviewer would circle in red: boxes on top of
 * each other, a label sitting on a box, a line running behind a box it does
 * not connect to. It does not fix anything; it tells the agent what to change
 * in the data (or confirms the picture is clean).
 */
import type { Pt } from './svg.ts';
import { simplify } from './svg.ts';

export type Box = { x: number; y: number; w: number; h: number };

export function boxOf(cx: number, cy: number, w: number, h: number): Box {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function inflate(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d };
}

export function overlaps(a: Box, b: Box, tol = 0): boolean {
  return (
    a.x < b.x + b.w - tol && b.x < a.x + a.w - tol && a.y < b.y + b.h - tol && b.y < a.y + a.h - tol
  );
}

export function union(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function polylineBox(points: Pt[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** True when an axis-aligned segment passes through the inside of a box. */
export function segmentHitsBox(a: Pt, b: Pt, box: Box, inset = 2): boolean {
  const bx0 = box.x + inset;
  const bx1 = box.x + box.w - inset;
  const by0 = box.y + inset;
  const by1 = box.y + box.h - inset;
  if (Math.abs(a.y - b.y) < 0.01) {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return a.y > by0 && a.y < by1 && x1 > bx0 && x0 < bx1;
  }
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return a.x > bx0 && a.x < bx1 && y1 > by0 && y0 < by1;
}

export function segments(points: Pt[]): [Pt, Pt][] {
  const pts = simplify(points);
  const out: [Pt, Pt][] = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1]!, pts[i]!]);
  return out;
}

/** The point where a horizontal and a vertical segment cross, strictly inside
 *  both, or null. */
export function crossing(h: [Pt, Pt], v: [Pt, Pt]): Pt | null {
  const [h0, h1] = h;
  const [v0, v1] = v;
  if (Math.abs(h0.y - h1.y) > 0.01 || Math.abs(v0.x - v1.x) > 0.01) return null;
  const x = v0.x;
  const y = h0.y;
  const inH = x > Math.min(h0.x, h1.x) + 0.5 && x < Math.max(h0.x, h1.x) - 0.5;
  const inV = y > Math.min(v0.y, v1.y) + 0.5 && y < Math.max(v0.y, v1.y) - 0.5;
  return inH && inV ? { x, y } : null;
}

/** True when two parallel axis-aligned segments run on top of each other. */
export function collinearOverlap(a: [Pt, Pt], b: [Pt, Pt], tol = 2): boolean {
  const ah = Math.abs(a[0].y - a[1].y) < 0.01;
  const bh = Math.abs(b[0].y - b[1].y) < 0.01;
  if (ah !== bh) return false;
  if (ah) {
    if (Math.abs(a[0].y - b[0].y) >= tol) return false;
    const lo = Math.max(Math.min(a[0].x, a[1].x), Math.min(b[0].x, b[1].x));
    const hi = Math.min(Math.max(a[0].x, a[1].x), Math.max(b[0].x, b[1].x));
    return hi - lo > tol;
  }
  if (Math.abs(a[0].x - b[0].x) >= tol) return false;
  const lo = Math.max(Math.min(a[0].y, a[1].y), Math.min(b[0].y, b[1].y));
  const hi = Math.min(Math.max(a[0].y, a[1].y), Math.max(b[0].y, b[1].y));
  return hi - lo > tol;
}

/** Hops for a set of drawn lines: each later line hops over every earlier
 *  line it crosses, on its horizontal runs where it can. */
export function hopsFor(lines: Pt[][]): Pt[][] {
  const segs = lines.map((l) => segments(l));
  return segs.map((mine, i) => {
    const hops: Pt[] = [];
    for (let j = 0; j < i; j++) {
      for (const s of mine) {
        for (const t of segs[j]!) {
          const sh = Math.abs(s[0].y - s[1].y) < 0.01;
          const c = sh ? crossing(s, t) : crossing(t, s);
          if (c) hops.push(c);
        }
      }
    }
    return hops;
  });
}

export type QaItem =
  { kind: 'box'; id: string; box: Box } | { kind: 'label'; id: string; box: Box };
export type QaLine = { id: string; points: Pt[]; ends: string[] };

/** The layout self-check: overlaps, labels on boxes, lines behind boxes,
 *  lines through labels, lines on top of lines. Returns readable warnings. */
export function qa(items: QaItem[], lines: QaLine[]): string[] {
  const out: string[] = [];
  const boxes = items.filter((i) => i.kind === 'box');
  const labels = items.filter((i) => i.kind === 'label');
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i]!.box, boxes[j]!.box, 1)) {
        out.push(`layout: '${boxes[i]!.id}' and '${boxes[j]!.id}' overlap.`);
      }
    }
  }
  for (const l of labels) {
    for (const b of boxes) {
      if (overlaps(l.box, b.box, 1)) out.push(`layout: label of '${l.id}' sits on '${b.id}'.`);
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlaps(labels[i]!.box, labels[j]!.box, 1)) {
        out.push(`layout: labels of '${labels[i]!.id}' and '${labels[j]!.id}' overlap.`);
      }
    }
  }
  for (const line of lines) {
    for (const [a, b] of segments(line.points)) {
      for (const bx of boxes) {
        if (line.ends.includes(bx.id)) continue;
        if (segmentHitsBox(a, b, bx.box)) {
          out.push(`layout: line '${line.id}' runs behind '${bx.id}'.`);
          break;
        }
      }
    }
  }
  // A line through a label that is not its own: the label is unreadable
  // where the line crosses it (a reflux line through a valve's tag, an
  // arrowhead on a circuit's name).
  for (const line of lines) {
    for (const l of labels) {
      if (l.id === line.id || l.id === `line ${line.id}` || line.ends.includes(l.id)) continue;
      if (segments(line.points).some(([a, b]) => segmentHitsBox(a, b, l.box))) {
        out.push(`layout: line '${line.id}' runs through the label of '${l.id}'.`);
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const sa = segments(lines[i]!.points);
      const sb = segments(lines[j]!.points);
      if (sa.some((s) => sb.some((t) => collinearOverlap(s, t)))) {
        out.push(`layout: lines '${lines[i]!.id}' and '${lines[j]!.id}' run on top of each other.`);
      }
    }
  }
  return [...new Set(out)];
}

/** The doc-wide size preset's width (docs/diagram-guides: output sizes). */
export const DOC_WIDE_W = 1280;

/** Warnings for a sheet past the size and crossing budgets. */
export function budgetWarnings(width: number, crossings: number, maxCrossings: number): string[] {
  const out: string[] = [];
  if (width > DOC_WIDE_W) {
    out.push(
      `size: the drawing is ${Math.round(width)} px wide, past the doc-wide ${DOC_WIDE_W}: split it, or move parts with column and row hints.`,
    );
  }
  if (crossings > maxCrossings) {
    out.push(
      `budget: ${crossings} line crossings (aim for ${maxCrossings} or fewer): reorder with column and row hints, set fromPort and toPort, or split the sheet.`,
    );
  }
  return out;
}

/**
 * The legend: a horizontal strip at the bottom, after a hairline, never
 * floating inside the drawing. It lists every treatment the drawing uses and
 * nothing else; the caller decides which entries are used.
 */
import { el, textEl } from './svg.ts';
import { PALETTE, gridUp } from './style.ts';
import { measure, type Measurer } from './text.ts';

export type LegendEntry = {
  label: string;
  /** Draws the sample into a 28 x 12 slot whose top-left is (x, y). */
  swatch: (x: number, y: number) => string;
};

const SWATCH_W = 28;
const ROW_H = 20;

/** Draw the strip at `top`, `width` wide. Returns the markup and the height
 *  it takes (0 when there are no entries). */
export function legendStrip(
  m: Measurer,
  entries: LegendEntry[],
  left: number,
  top: number,
  width: number,
): { svg: string; height: number } {
  if (!entries.length) return { svg: '', height: 0 };
  const parts: string[] = [
    el('line', {
      x1: left,
      y1: top,
      x2: left + width,
      y2: top,
      stroke: PALETTE.rule,
      'stroke-width': 1,
    }),
  ];
  let x = left;
  let y = top + 16;
  for (const e of entries) {
    const tw = measure(m, e.label, 'legend');
    const w = gridUp(SWATCH_W + 8 + tw + 24);
    if (x > left && x + w > left + width) {
      x = left;
      y += ROW_H;
    }
    parts.push(e.swatch(x, y));
    parts.push(textEl('legend', x + SWATCH_W + 8, y + 9, e.label, { fill: PALETTE.muted }));
    x += w;
  }
  return { svg: el('g', { 'data-part': 'legend' }, parts), height: y + ROW_H - top };
}

/** A box sample for a node treatment. */
export function boxSwatch(fill: string, stroke: string, dash?: string) {
  return (x: number, y: number) =>
    el('rect', {
      x,
      y,
      width: SWATCH_W,
      height: 12,
      rx: 2,
      fill,
      stroke,
      'stroke-width': 1,
      'stroke-dasharray': dash,
    });
}

/** A line sample for a connector treatment. */
export function lineSwatch(stroke: string, width = 1.2, dash?: string) {
  return (x: number, y: number) =>
    el('line', {
      x1: x,
      y1: y + 6,
      x2: x + SWATCH_W,
      y2: y + 6,
      stroke,
      'stroke-width': width,
      'stroke-dasharray': dash,
    });
}

/** A text sample in a mark's colour: what a coloured word on the drawing
 *  (a GUESS note, a page reference) means. */
export function markSwatch(colour: string, sample = 'Abc') {
  return (x: number, y: number) => textEl('legend', x + 2, y + 9, sample, { fill: colour });
}

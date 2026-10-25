/**
 * A drawing set as one static SVG: every page stacked top to bottom, each
 * under a header that names it ("PAGE 2 OF 5: <title>"). This is the
 * set's export (`window.diagram.exportSvg()`, `present_export`): a static
 * copy cannot switch pages, so it holds them all, and every link in it is
 * already printed as a page reference by the page's own template.
 *
 * Each page is a whole SVG document from its template; here its root tag
 * becomes a nested `<svg>` placed at its offset, so its drawing, its own
 * title and its ids stay as they were (the caller gives each page its own
 * id prefix, so no two pages share an id).
 */
import { el, num, textEl } from './svg.ts';
import { svgDocument } from './export.ts';
import { PALETTE } from './style.ts';

export type StackPage = { id: string; title: string; svg: string; width: number; height: number };

/** The header band above each page. */
const HEAD = 32;
/** The gap between one page and the next header. */
const GAP = 24;

/** The page reference a set prints for a link: "see page 3: <title>". */
export function pageRef(n: number, title: string, max = 40): string {
  const head = `see page ${n}: `;
  const room = Math.max(4, max - head.length);
  return head + (title.length > room ? `${title.slice(0, room - 3)}...` : title);
}

export function stackPages(input: {
  title: string;
  desc: string;
  idPrefix: string;
  generator: string;
  pages: StackPage[];
}): { svg: string; width: number; height: number } {
  const width = Math.max(480, ...input.pages.map((p) => p.width));
  let y = 0;
  const parts: string[] = [];
  input.pages.forEach((p, i) => {
    if (i > 0) {
      parts.push(
        el('line', {
          x1: 0,
          y1: y + GAP / 2,
          x2: width,
          y2: y + GAP / 2,
          stroke: PALETTE.ruleSolid,
          'stroke-width': 1,
        }),
      );
      y += GAP;
    }
    parts.push(
      textEl('eyebrow', 16, y + 20, `Page ${i + 1} of ${input.pages.length}: ${p.title}`, {
        fill: PALETTE.muted,
      }),
    );
    y += HEAD;
    const inner = p.svg.replace(
      /^<svg\b[^>]*>/,
      `<svg x="0" y="${num(y)}" width="${num(p.width)}" height="${num(p.height)}" viewBox="0 0 ${num(p.width)} ${num(p.height)}" data-page="${p.id.replace(/[^A-Za-z0-9_.-]/g, '')}">`,
    );
    parts.push(inner);
    y += p.height;
  });
  const height = Math.max(1, Math.ceil(y));
  return {
    svg: svgDocument({
      width,
      height,
      title: input.title,
      desc: input.desc,
      idPrefix: input.idPrefix,
      generator: input.generator,
      body: parts.join(''),
    }),
    width,
    height,
  };
}

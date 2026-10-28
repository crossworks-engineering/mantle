import { z } from 'zod';

/**
 * The print options of a page or drawing export (GET /api/export/:id
 * ?format=pdf): paper size, orientation, margins, a header and a footer
 * line with page numbers. Validated with safe defaults (the a4 portrait print every
 * export was before), and honoured by both engines: the documents engine
 * (Gotenberg, chromium/convert/url) and the browser sidecar (puppeteer
 * page.pdf). A client adds them to its Export menu as query parameters;
 * nothing here reaches the engine as raw HTML: a header or footer is text,
 * escaped into the one template below.
 *
 *   paper=a4|a3|a5|letter|legal      default a4
 *   landscape=1                      default off
 *   margin=<mm>                      every side; default 18 top and bottom,
 *   margin_top=.. margin_right=..    16 left and right; 0 to 60
 *   margin_bottom=.. margin_left=..
 *   header=<text>                    a line at the top of every page (200
 *                                    characters at most)
 *   footer=<text>                    a line at the bottom of every page
 *   page_numbers=1                   "Page N of M" at the bottom right
 */
export const PAPER_SIZES = {
  // inches, portrait
  a4: { width: 8.27, height: 11.69 },
  a3: { width: 11.69, height: 16.54 },
  a5: { width: 5.83, height: 8.27 },
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;

export type PrintOptions = {
  paper: PaperSize;
  landscape: boolean;
  /** Millimetres. */
  margins: { top: number; right: number; bottom: number; left: number };
  header: string | null;
  footer: string | null;
  pageNumbers: boolean;
};

export const DEFAULT_PRINT_OPTIONS: PrintOptions = Object.freeze({
  paper: 'a4',
  landscape: false,
  margins: Object.freeze({ top: 18, right: 16, bottom: 18, left: 16 }),
  header: null,
  footer: null,
  pageNumbers: false,
});

const MAX_MARGIN_MM = 60;
const MAX_TEXT = 200;
/** Room a header or footer line needs: a margin under this grows to it. */
const CHROME_MARGIN_MM = 14;

const mm = z.coerce.number().min(0).max(MAX_MARGIN_MM);
const flag = z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true');
const text = z.string().trim().max(MAX_TEXT);

const Query = z.object({
  paper: z.enum(['a4', 'a3', 'a5', 'letter', 'legal']).optional(),
  landscape: flag.optional(),
  margin: mm.optional(),
  margin_top: mm.optional(),
  margin_right: mm.optional(),
  margin_bottom: mm.optional(),
  margin_left: mm.optional(),
  header: text.optional(),
  footer: text.optional(),
  page_numbers: flag.optional(),
});

/** The options a query names, or the first problem (a 400 for the route). */
export function parsePrintOptions(
  query: URLSearchParams,
): { ok: true; options: PrintOptions } | { ok: false; error: string } {
  const raw: Record<string, string> = {};
  for (const k of Object.keys(Query.shape)) {
    const v = query.get(k);
    if (v !== null && v !== '') raw[k] = v;
  }
  const parsed = Query.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `print option ${issue?.path.map(String).join('.') || 'query'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  const q = parsed.data;
  const d = DEFAULT_PRINT_OPTIONS;
  const header = q.header || null;
  const footer = q.footer || null;
  const pageNumbers = q.page_numbers ?? false;
  const margins = {
    top: q.margin_top ?? q.margin ?? d.margins.top,
    right: q.margin_right ?? q.margin ?? d.margins.right,
    bottom: q.margin_bottom ?? q.margin ?? d.margins.bottom,
    left: q.margin_left ?? q.margin ?? d.margins.left,
  };
  // A header or footer line needs room: a margin cut under it would print
  // the line over the content.
  if (header) margins.top = Math.max(margins.top, CHROME_MARGIN_MM);
  if (footer || pageNumbers) margins.bottom = Math.max(margins.bottom, CHROME_MARGIN_MM);
  return {
    ok: true,
    options: {
      paper: q.paper ?? d.paper,
      landscape: q.landscape ?? false,
      margins,
      header,
      footer,
      pageNumbers,
    },
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The one header or footer line, as the fragment Chromium's print chrome
 *  takes (the browser sidecar's headerTemplate): text on the left, the
 *  page number on the right. `pageNumber` and `totalPages` are the class
 *  names both engines fill in. */
export function chromeFragment(text: string | null, pageNumbers: boolean): string | null {
  if (!text && !pageNumbers) return null;
  const left = text ? `<span>${esc(text)}</span>` : '<span></span>';
  const right = pageNumbers
    ? '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>'
    : '<span></span>';
  return (
    `<div style="font-family:sans-serif;font-size:9px;color:#666;width:100%;` +
    `margin:0 16mm;display:flex;justify-content:space-between">${left}${right}</div>`
  );
}

/** The same line as the full HTML document the documents engine takes
 *  (header.html, footer.html). */
export function chromeDocument(fragment: string | null): string | null {
  if (!fragment) return null;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${fragment}</body></html>`;
}

/** The header and footer of a print, by the options: the header line at the
 *  top; the footer line and the page numbers at the bottom. */
export function printChrome(o: PrintOptions): { header: string | null; footer: string | null } {
  return {
    header: chromeFragment(o.header, false),
    footer: chromeFragment(o.footer, o.pageNumbers),
  };
}

/** The paper in inches, as printed (landscape swaps the sides). */
export function paperInches(o: PrintOptions): { width: number; height: number } {
  const p = PAPER_SIZES[o.paper];
  return o.landscape ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

export const mmToInches = (v: number): number => Math.round((v / 25.4) * 1000) / 1000;

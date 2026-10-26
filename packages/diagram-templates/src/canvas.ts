/**
 * A diagram template as a Present canvas (docs/proposals/canvas-files.md
 * section 4.2): one self-contained HTML document with the canvas head, the
 * DATA in one JSON block, and the runtime that lays it out and draws it.
 *
 *   <head>  <title>, <meta name="description">, canvas:size=fill,
 *           canvas:theme=fixed (a drawing uses the light skin only), and
 *           diagram:template=<name>@<version>
 *   <body>  <main id="diagram">            the live drawing goes here
 *           <div id="diagram-errors">      data errors, shown in the page
 *           <script type="application/json" id="diagram-data">   THE DATA
 *           the runtime: inline (default), or an import of
 *           '@mantle/diagram-templates/browser' through the frame's import map
 *
 * The agent edits only the data block (`replaceCanvasData`); the template,
 * style and runtime come from this package. The file stays the editable
 * source; `window.diagram.exportSvg()` gives the static SVG for pages,
 * print, Word, email and public shares.
 */
import { esc } from './runtime/svg.ts';
import { messageOf } from './runtime/validate.ts';
import { PALETTE } from './runtime/style.ts';
import { TEMPLATES, isTemplateName, type TemplateName } from './index.ts';
import {
  honestImageChecks,
  imageChecksStale,
  withImageCheckSummary,
  type SealCheck,
} from './templates/pid/check.ts';

/** `inline`: the runtime is inside the file (works anywhere, offline, from
 *  file://; about 110 KB). `import`: the file imports the runtime by name
 *  and needs a host import map that serves it (the Present frame, once the
 *  brain ships it in /canvas-runtime/). */
export type CanvasMode = 'inline' | 'import';

export const DATA_ID = 'diagram-data';
export const RUNTIME_SPECIFIER = '@mantle/diagram-templates/browser';

/** JSON that cannot close its `<script>` tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const PAGE_CSS = `
html,body{margin:0;background:${PALETTE.paper};color:${PALETTE.ink}}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;padding:16px}
#diagram{width:100%;display:flex;justify-content:center}
#diagram svg{max-width:100%;height:auto}
#diagram-errors{display:none;max-width:720px;font:13px/1.5 ui-monospace,Menlo,monospace;color:#8a2a12;background:#fff;border:1px solid #e3c9bf;border-radius:6px;padding:12px 16px;white-space:pre-wrap}
#diagram-errors.show{display:block}
`.trim();

export type BuildCanvasInput = {
  template: TemplateName;
  data: unknown;
  mode?: CanvasMode;
  /** The browser runtime as one classic script (dist/diagram-runtime.js),
   *  required for `inline`. */
  runtime?: string;
};

export function buildCanvas(input: BuildCanvasInput): string {
  const mode = input.mode ?? 'inline';
  if (!isTemplateName(input.template))
    throw new Error(`canvas: unknown template '${input.template}'`);
  const t = TEMPLATES[input.template];
  const d = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<
    string,
    unknown
  >;
  const title = typeof d.title === 'string' && d.title ? d.title : `${t.name} diagram`;
  const description = typeof d.description === 'string' ? d.description : '';
  let runtime: string;
  if (mode === 'inline') {
    if (!input.runtime)
      throw new Error(
        'canvas: inline mode needs the built runtime (pnpm -C packages/diagram-templates build)',
      );
    // A classic script: the frame CSP allows inline script, nothing else.
    runtime = `<script>${input.runtime.replace(/<\/script/gi, '<\\/script')}</script>`;
  } else {
    runtime = `<script type="module">import { mount } from '${RUNTIME_SPECIFIER}';\nmount();</script>`;
  }
  const data = { template: t.name, version: t.version, ...d };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    description ? `<meta name="description" content="${esc(description)}">` : '',
    '<meta name="canvas:size" content="fill">',
    '<meta name="canvas:theme" content="fixed">',
    `<meta name="diagram:template" content="${t.name}@${t.version}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    '<main id="diagram" aria-live="polite"></main>',
    '<div id="diagram-errors" role="alert"></div>',
    `<script type="application/json" id="${DATA_ID}">\n${scriptJson(data)}\n</script>`,
    runtime,
    '</body>',
    '</html>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The data block as this package writes it: its JSON never holds a `<`
 *  (scriptJson escapes it), so the block ends at the first `<`, which must
 *  open `</script>`. A block whose text holds a `<` (a `</SCRIPT>` the
 *  browser ends it at, or a `<!--<script>` that keeps it open past the
 *  first close) is not one this package wrote, and is not read as one. */
const DATA_BLOCK = new RegExp(
  `(<script type="application/json" id="${DATA_ID}">)([^<]*)(</script>)`,
);

/** The data block of a canvas, parsed. Throws with a clear message when the
 *  block is missing or not JSON. */
export function readCanvasData(html: string): Record<string, unknown> {
  const m = DATA_BLOCK.exec(html);
  if (!m) throw new Error(`canvas: no <script type="application/json" id="${DATA_ID}"> block`);
  try {
    return JSON.parse(m[2]!) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`canvas: the data block is not valid JSON (${messageOf(err)})`, { cause: err });
  }
}

/** The same canvas with new data, and the title and description in the head
 *  kept in step with it. Everything else is left exactly as it was. */
export function replaceCanvasData(html: string, data: Record<string, unknown>): string {
  if (!DATA_BLOCK.test(html)) throw new Error(`canvas: no data block to replace`);
  let out = html.replace(
    DATA_BLOCK,
    (_, open: string, __: string, close: string) => `${open}\n${scriptJson(data)}\n${close}`,
  );
  if (typeof data.title === 'string')
    // A function replacer: a title with `$&` or `$'` is text, not a pattern.
    out = out.replace(
      /<title>[\s\S]*?<\/title>/,
      () => `<title>${esc(String(data.title))}</title>`,
    );
  if (typeof data.description === 'string') {
    out = out.replace(
      /<meta name="description" content="[^"]*">/,
      () => `<meta name="description" content="${esc(String(data.description))}">`,
    );
  }
  return out;
}

/** HTML whitespace (the tokenizer's: tab, LF, FF, CR, space). */
const WS = new Set(['\t', '\n', '\f', '\r', ' ']);

/** An attribute value with its numeric character references decoded, as
 *  a browser reads it (with or without the closing `;`), and `&amp;`. */
function decodeRefs(value: string): string {
  return value
    .replace(
      /&#[xX]([0-9a-fA-F]+);?|&#(\d+);?/g,
      (m, hex: string | undefined, dec: string | undefined) => {
        const n = hex !== undefined ? parseInt(hex, 16) : Number(dec);
        return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      },
    )
    .replace(/&amp;?/gi, '&');
}

/**
 * The `id` attributes of every start tag in `html`, read as the HTML
 * tokenizer reads a tag's attributes (any case, any order, quoted or not,
 * `/` between them). A superset: a tag is read at EVERY `<` followed by a
 * letter, inside comments, scripts and attribute values too, so no element
 * the browser makes is missed (text that only looks like a tag adds one);
 * prose with no `<` before it never counts.
 */
function idValues(html: string): string[] {
  const out: string[] = [];
  const n = html.length;
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    if (!/[A-Za-z]/.test(html[at + 1] ?? '')) continue;
    let i = at + 1;
    while (i < n && !WS.has(html[i]!) && html[i] !== '/' && html[i] !== '>') i += 1;
    for (;;) {
      while (i < n && (WS.has(html[i]!) || html[i] === '/')) i += 1;
      if (i >= n || html[i] === '>') break;
      // The name: its first character may be `=`.
      const start = i;
      i += 1;
      while (i < n && !WS.has(html[i]!) && !'/>='.includes(html[i]!)) i += 1;
      const name = html.slice(start, i).toLowerCase();
      while (i < n && WS.has(html[i]!)) i += 1;
      let value: string | null = null;
      if (html[i] === '=') {
        i += 1;
        while (i < n && WS.has(html[i]!)) i += 1;
        const q = html[i];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1);
          value = html.slice(i + 1, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
        } else {
          const start2 = i;
          while (i < n && !WS.has(html[i]!) && html[i] !== '>') i += 1;
          value = html.slice(start2, i);
        }
      }
      if (name === 'id' && value !== null) out.push(value);
    }
  }
  return out;
}

/** Whether an id could be the data block's to a browser: the id once its
 *  character references are decoded (any case: a loose match), or any id
 *  with a reference in it that names a diagram (a named reference this
 *  check does not decode). */
function dataBlockId(value: string): boolean {
  const decoded = decodeRefs(value);
  if (decoded.toLowerCase() === DATA_ID) return true;
  return value.includes('&') && /diagram/i.test(decoded.replace(/&[A-Za-z][A-Za-z0-9]*;?/g, ''));
}

/**
 * How many elements of a canvas carry the data block's id, in any form a
 * browser reads (`document.getElementById`, which the runtime uses: any
 * tag, any attribute order, case or quoting, character references
 * decoded; read at every tag-like position, so text that only looks like
 * a tag counts too, prose does not), and how many data blocks it holds as
 * this package writes them (`readCanvasData` reads the first). A save
 * normalizes a canvas's image checks through `readCanvasData`, so a canvas
 * where the two are not both 0 or both 1 (a second block, or one in
 * another form) could show the view data no save looked at: the content
 * layer refuses to store it. Limit: a canvas is HTML its writer controls,
 * and one that draws its own marks with its own script is not a drawing
 * this check vouches for; this closes the data block the runtime reads.
 */
export function dataBlockCount(html: string): { any: number; written: number } {
  const any = idValues(html).filter(dataBlockId).length;
  const written = html.match(new RegExp(DATA_BLOCK.source, 'g'));
  return { any, written: written?.length ?? 0 };
}

/** Whether a canvas's one data block reads as a JSON object (what the
 *  runtime draws from). A save refuses a canvas whose block does not:
 *  the browser may read it where this package cannot. */
export function canvasDataReadable(html: string): boolean {
  try {
    const d: unknown = readCanvasData(html);
    return typeof d === 'object' && d !== null && !Array.isArray(d);
  } catch {
    return false;
  }
}

/** The data of a canvas whose data block may draw a `pid` (pid/check.ts):
 *  keyed off the data block itself, as the runtime picks its template
 *  (`data.template`, else the head's diagram:template meta). Data naming
 *  another template is not; data naming none is taken (whatever the meta
 *  says, the marks are normalized: a superset, never a miss). Null when
 *  there is no data block or it does not parse (a save refuses a canvas
 *  whose one block does not: @mantle/content drawing-seal). */
function pidDataOf(html: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = readCanvasData(html);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const t = (data as { template?: unknown }).template;
  return t === undefined || t === 'pid' ? (data as Record<string, unknown>) : null;
}

/**
 * A `pid` canvas as every save stores it (@mantle/content presents.ts
 * createPresent and savePresentSource): its marks normalized against
 * circuit_trace's seals (`honestImageChecks`: no trust word typed into a
 * label; a mark whose seal does not hold where it sits is unchecked, its
 * evidence stripped; without a sealed provenance every mark is), then its
 * counts recounted. Byte for byte unchanged when
 * nothing changes; only the data block changes otherwise.
 */
export function withHonestImageChecks(html: string, holds: SealCheck): string {
  const data = pidDataOf(html);
  if (!data) return html;
  const honest = honestImageChecks(data, holds);
  const own = imageChecksStale(honest) ? withImageCheckSummary(honest) : honest;
  return own === data ? html : withData(html, own);
}

function withData(html: string, data: unknown): string {
  return html.replace(
    DATA_BLOCK,
    (_, open: string, __: string, close: string) => `${open}\n${scriptJson(data)}\n${close}`,
  );
}

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
/** The assets block: pictures the drawing shows on request (the image
 *  check's crops, by file id), embedded so the frame loads nothing. */
export const ASSETS_ID = 'diagram-assets';
export type CanvasAssets = { crops: Record<string, string> };
export const RUNTIME_SPECIFIER = '@mantle/diagram-templates/browser';

/** JSON that cannot close its `<script>` tag, and that every parser reads
 *  alike: no `<` (no tag, comment or CDATA can start in it), no `>` and no
 *  `&` (inside `<svg>` or `<math>` a browser decodes character references
 *  in a script's text, which a server reading the raw text would not), and
 *  no U+2028/2029. JSON.parse reads the escapes back as the same text. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
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
  /** Embedded pictures (crops); no block when absent or empty. */
  assets?: CanvasAssets;
};

function assetsBlock(assets: CanvasAssets | null | undefined): string {
  if (!assets || !Object.keys(assets.crops).length) return '';
  const json = JSON.stringify({ crops: assets.crops })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="${ASSETS_ID}">${json}</script>`;
}

/** The import-mode runtime: the shipped runtime, by name, through the
 *  frame's import map. */
const IMPORT_RUNTIME = `<script type="module">import { mount } from '${RUNTIME_SPECIFIER}';\nmount();</script>`;

/** The canvas document, the one writer of its shape (buildCanvas, and a
 *  save's canonical rebuild, canonicalPidCanvas). `titleHtml` and
 *  `descriptionHtml` are already escaped. */
function canvasDocument(parts: {
  name: TemplateName;
  version: number;
  titleHtml: string;
  descriptionHtml: string | null;
  dataJson: string;
  /** The assets block, written (assetsBlock), or '' for none. */
  assetsHtml: string;
  runtime: string;
}): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${parts.titleHtml}</title>`,
    parts.descriptionHtml !== null
      ? `<meta name="description" content="${parts.descriptionHtml}">`
      : '',
    '<meta name="canvas:size" content="fill">',
    '<meta name="canvas:theme" content="fixed">',
    `<meta name="diagram:template" content="${parts.name}@${parts.version}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    '<main id="diagram" aria-live="polite"></main>',
    '<div id="diagram-errors" role="alert"></div>',
    `<script type="application/json" id="${DATA_ID}">\n${parts.dataJson}\n</script>`,
    parts.assetsHtml,
    parts.runtime,
    '</body>',
    '</html>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

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
    runtime = IMPORT_RUNTIME;
  }
  return canvasDocument({
    name: t.name,
    version: t.version,
    titleHtml: esc(title),
    descriptionHtml: description ? esc(description) : null,
    dataJson: scriptJson({ template: t.name, version: t.version, ...d }),
    assetsHtml: assetsBlock(input.assets),
    runtime,
  });
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
 * The attributes of every start tag in `html`, read as the HTML tokenizer
 * reads a tag's attributes (any case, any order, quoted or not, `/`
 * between them), raw (references not decoded), one list per tag. A
 * superset: a tag is read at EVERY `<` followed by a letter, inside
 * comments, scripts and attribute values too, so no element the browser
 * makes is missed (text that only looks like a tag adds one); prose with
 * no `<` before it never counts.
 */
function tagAttributes(html: string): [name: string, value: string | null][][] {
  const tags: [string, string | null][][] = [];
  const n = html.length;
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    if (!/[A-Za-z]/.test(html[at + 1] ?? '')) continue;
    const attrs: [string, string | null][] = [];
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
      attrs.push([name, value]);
    }
    tags.push(attrs);
  }
  return tags;
}

/** The `id` attributes of every start tag in `html` (tagAttributes). */
function idValues(html: string): string[] {
  return tagAttributes(html).flatMap((attrs) =>
    attrs.flatMap(([name, value]) => (name === 'id' && value !== null ? [value] : [])),
  );
}

/** Whether an id could be the data block's to a browser. `loose` (a canvas
 *  that claims the `pid` template): the id once its character references
 *  are decoded, in any case, or any id with a reference in it that names a
 *  diagram (a named reference this check does not decode). Otherwise only
 *  an id `document.getElementById` finds: its numeric references and
 *  `&amp;` decoded, exactly (no named reference decodes to a letter or to
 *  `-`, so `diagram&amp;chart` is not one). */
function dataBlockId(value: string, loose: boolean): boolean {
  const decoded = decodeRefs(value);
  if (!loose) return decoded === DATA_ID;
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
 * normalizes a canvas's data through `readCanvasData`, so a canvas where
 * the two are not both 0 or both 1 (a second block, or one in another
 * form) could show the view data no save looked at: the content layer
 * refuses to store it. `loose` (the default; what a canvas that claims the
 * `pid` template is held to, `claimsPidTemplate`) also counts ids that
 * only look like the block's (any case, a named reference); a canvas that
 * claims no template counts only the ids a browser would find.
 */
export function dataBlockCount(
  html: string,
  opts: { loose?: boolean } = {},
): { any: number; written: number } {
  const loose = opts.loose ?? true;
  const any = idValues(html).filter((v) => dataBlockId(v, loose)).length;
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

/**
 * Whether a canvas claims the `pid` template, as the runtime could pick
 * it: its written data block names it (`data.template`), or any tag
 * carries a `diagram:template` name whose content names `pid` (read as
 * `tagAttributes` reads, references decoded, any case: a superset of the
 * runtime's `meta[name="diagram:template"]`). Such a canvas must be
 * exactly what buildCanvas writes (canonicalPidCanvas); any other canvas
 * is the author's own HTML.
 */
export function claimsPidTemplate(html: string): boolean {
  for (const attrs of tagAttributes(html)) {
    const named = attrs.some(
      ([k, v]) =>
        k === 'name' && v !== null && decodeRefs(v).trim().toLowerCase() === 'diagram:template',
    );
    if (
      named &&
      attrs.some(
        ([k, v]) => k === 'content' && v !== null && /^\s*pid\s*(?:@|$)/i.test(decodeRefs(v)),
      )
    )
      return true;
  }
  try {
    return readCanvasData(html).template === 'pid';
  } catch {
    return false;
  }
}

/** A canvas that claims the `pid` template but is not exactly what
 *  buildCanvas writes: a save refuses it (@mantle/content drawing-seal
 *  words it for whoever saved). */
export class CanvasShapeError extends Error {
  constructor() {
    super('canvas: a pid canvas holds only what buildCanvas writes');
    this.name = 'CanvasShapeError';
  }
}

/** A regular expression source for `s`, literally. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The shape of a `pid` canvas as buildCanvas writes it, its variable parts
 * captured, white space between tags free: the head's title text (1) and
 * description (2, absent when the canvas has none), the data block's JSON
 * (3) and the runtime (4: the
 * import of the shipped runtime, or one inline classic script, which a
 * save replaces with the import). Built from the one writer
 * (canvasDocument), so the two cannot drift. Built on first use (index.ts
 * and this module import each other).
 */
let pidShape: RegExp | null = null;
const PID_SHAPE = (): RegExp => (pidShape ??= shapeOfPid());
function shapeOfPid(): RegExp {
  const mark = (c: string) => `\u0000${c}\u0000`;
  const t = TEMPLATES.pid;
  let src = literal(
    canvasDocument({
      name: t.name,
      version: t.version,
      titleHtml: mark('T'),
      descriptionHtml: mark('D'),
      dataJson: mark('J'),
      assetsHtml: '',
      runtime: mark('R'),
    }),
  );
  const desc = literal(`\n<meta name="description" content="${mark('D')}">`);
  src = src
    .replace(desc, '(?:\\s*<meta name="description" content="([^"<>]*)">)?')
    .replace(mark('T'), '([^<]*)')
    .replace(mark('J'), '([^<]*)')
    .replace(
      mark('R'),
      `(${literal(IMPORT_RUNTIME)}|<script>(?:(?!<\\/script)[\\s\\S])*<\\/script>)`,
    );
  // White space between the tags is the writer's (an edit that adds a line
  // break changes nothing a browser builds); the rebuild writes its own.
  return new RegExp(`^\\s*${src.replace(/\n/g, '\\s*')}\\s*$`);
}

/**
 * A `pid` canvas rebuilt as buildCanvas writes it from `data` (the honest
 * data a save stores), keeping the canvas's own head title and description
 * text as written (text a browser shows as the frame's title, never
 * markup) and the shipped runtime by import. Null when `html` holds
 * anything buildCanvas does not write: another script, markup around or
 * inside the drawing's elements, any other head or body content.
 */
export function canonicalPidCanvas(html: string, data: Record<string, unknown>): string | null {
  const m = PID_SHAPE().exec(html);
  if (!m) return null;
  const t = TEMPLATES.pid;
  return canvasDocument({
    name: t.name,
    version: t.version,
    titleHtml: m[1]!,
    descriptionHtml: m[2] ?? null,
    dataJson: scriptJson({ template: t.name, version: t.version, ...data }),
    assetsHtml: '',
    runtime: IMPORT_RUNTIME,
  });
}

/**
 * A canvas as every save stores it (@mantle/content presents.ts
 * createPresent and savePresentSource). One that claims the `pid` template
 * (claimsPidTemplate) is rebuilt exactly as buildCanvas writes it
 * (canonicalPidCanvas) from its data with its marks normalized against
 * circuit_trace's seals (`honestImageChecks`: no trust word typed into a
 * label; a mark whose seal does not hold where it sits is unchecked, its
 * evidence stripped; without a sealed provenance every mark is) and its
 * counts recounted; one that holds anything else throws CanvasShapeError.
 * Any other canvas with a data block keeps everything but the block, which
 * is written again from its parsed JSON (scriptJson: no `&`, `<` or `>`,
 * so the stored text reads alike everywhere). Byte for byte unchanged
 * when nothing changes; a canvas with no readable block is returned as it
 * was (the content layer refuses it first).
 */
export function withHonestImageChecks(html: string, holds: SealCheck): string {
  let data: unknown;
  try {
    data = readCanvasData(html);
  } catch {
    if (claimsPidTemplate(html)) throw new CanvasShapeError();
    return html;
  }
  if (!claimsPidTemplate(html)) return withData(html, data);
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new CanvasShapeError();
  const honest = honestImageChecks(data as Record<string, unknown>, holds);
  const own = imageChecksStale(honest) ? withImageCheckSummary(honest) : honest;
  const out = canonicalPidCanvas(html, own);
  if (out === null) throw new CanvasShapeError();
  return out;
}

function withData(html: string, data: unknown): string {
  const out = html.replace(
    DATA_BLOCK,
    (_, open: string, __: string, close: string) => `${open}\n${scriptJson(data)}\n${close}`,
  );
  return out;
}

const ASSETS_BLOCK = new RegExp(
  `<script type="application/json" id="${ASSETS_ID}">[\\s\\S]*?</script>\\n?`,
);

/** The canvas's embedded pictures, or none. */
export function readCanvasAssets(html: string): CanvasAssets {
  const m = new RegExp(
    `<script type="application/json" id="${ASSETS_ID}">([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!m) return { crops: {} };
  try {
    const v = JSON.parse(m[1]!) as { crops?: unknown };
    const crops: Record<string, string> = {};
    if (v.crops && typeof v.crops === 'object')
      for (const [k, u] of Object.entries(v.crops)) if (typeof u === 'string') crops[k] = u;
    return { crops };
  } catch {
    return { crops: {} };
  }
}

/** The same canvas with its embedded pictures replaced (none: the block
 *  goes). The block sits right after the data block. */
export function replaceCanvasAssets(html: string, assets: CanvasAssets | null): string {
  const out = html.replace(ASSETS_BLOCK, '');
  const block = assetsBlock(assets);
  if (!block) return out;
  const m = DATA_BLOCK.exec(out);
  if (!m) throw new Error('canvas: no data block to put the assets after');
  const end = m.index + m[0].length;
  return `${out.slice(0, end)}\n${block}${out.slice(end)}`;
}

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
  CHECK_LIMITS,
  FILE_ID,
  SHA256,
  honestImageChecks,
  imageChecksStale,
  mapDrawings,
  mapImageChecks,
  withImageCheckSummary,
  type SealCheck,
} from './templates/pid/check.ts';
import { pidLimitsProblem } from './templates/pid/limits.ts';

/** `inline`: the runtime is inside the file (works anywhere, offline, from
 *  file://; about 110 KB). `import`: the file imports the runtime by name
 *  and needs a host import map that serves it (the Present frame, once the
 *  brain ships it in /canvas-runtime/). */
export type CanvasMode = 'inline' | 'import';

export const DATA_ID = 'diagram-data';
/** The assets block: pictures the drawing shows on request (the image
 *  check's crops, by file id), embedded so the frame loads nothing. */
export const ASSETS_ID = 'diagram-assets';
/** One embedded crop: its picture (a base64 JPEG, PNG or WebP data URL)
 *  and the server's seal of it (`cropSealPayload`), which every save checks
 *  (withSealedCanvasAssets): a picture the server did not embed for that
 *  file id never reaches the view. */
export type CanvasCrop = { src: string; sig: string };
export type CanvasAssets = { crops: Record<string, CanvasCrop> };

/** The one home of the crop limits (CHECK_LIMITS, pid/check.ts, holds the
 *  rest of the image check's). */
export const CROP_LIMITS = (() => {
  const bytes = 90_000;
  return {
    /** Crop file ids one check names. */
    perCheck: CHECK_LIMITS.crops,
    /** Crops embedded per canvas. */
    count: 24,
    /** Crop files a save tries to read, at most (an unreadable or
     *  non-picture id counts too). */
    reads: 48,
    /** One crop, as embedded JPEG bytes. */
    bytes,
    /** All crops of one canvas, as JPEG bytes (base64 adds a third). */
    totalBytes: 480_000,
    /** A crop file larger than this is not read (a crop is far smaller). */
    sourceBytes: 12 * 1024 * 1024,
    /** The longest crop data URL the view shows: one crop in base64. */
    urlChars: 'data:image/jpeg;base64,'.length + Math.ceil(bytes / 3) * 4,
  } as const;
})();

/** The purpose a crop is sealed under (@mantle/content sealPayload). v2
 *  binds the bytes the crop was read from: a crop sealed under v1 is
 *  dropped by the next save, and embedded again from its file. */
export const CROP_SEAL_PURPOSE = 'canvas-crop v2';
/** What the server seals of one crop: the file id it was read from, the
 *  sha256 (hex) of the embedded picture's bytes and the sha256 of the
 *  file's bytes it was made from, which is the one circuit_verify stored
 *  (a mark's `cropSha`, sealed with the mark). Not the canvas: a copied
 *  canvas keeps its crops. */
export function cropSealPayload(
  fileId: string,
  sha256: string,
  sourceSha256: string,
): [string, string, string] {
  return [fileId.toLowerCase(), sha256, sourceSha256];
}
export const RUNTIME_SPECIFIER = '@mantle/diagram-templates/browser';

/** JSON that cannot close its `<script>` tag, and that every parser reads
 *  alike: no `<` (no tag, comment or CDATA can start in it), no `>` and no
 *  `&` (inside `<svg>` or `<math>` a browser decodes character references
 *  in a script's text, which a server reading the raw text would not), and
 *  no U+2028/2029. JSON.parse reads the escapes back as the same text. */
export function scriptJson(value: unknown): string {
  return scriptSafe(JSON.stringify(value, null, 2));
}

/** JSON text escaped as scriptJson escapes it (the assets block's is
 *  written on one line). */
function scriptSafe(json: string): string {
  return json
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

/** The assets block as this package writes it (scriptJson's escapes, so
 *  it reads alike everywhere), or '' for no crops. */
function assetsBlock(assets: CanvasAssets | null | undefined): string {
  if (!assets || !Object.keys(assets.crops).length) return '';
  const json = scriptSafe(JSON.stringify({ crops: assets.crops }));
  return `<script type="application/json" id="${ASSETS_ID}">${json}</script>`;
}

/** The import-mode runtime's text: the shipped runtime, by name, through
 *  the frame's import map. The runtime trusts a drawing's marks only under
 *  exactly this script (data-read.ts). */
export const IMPORT_RUNTIME_TEXT = `import { mount } from '${RUNTIME_SPECIFIER}';\nmount();`;
/** The import-mode runtime, as buildCanvas writes it. */
const IMPORT_RUNTIME = `<script type="module">${IMPORT_RUNTIME_TEXT}</script>`;

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
  let out = replaceDataBlock(html, data);
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

/** The canvas with its (first) data block written again from `data`
 *  (scriptJson), nothing else touched: replaceCanvasData's write, and a
 *  save's for a canvas that claims no template. */
function replaceDataBlock(html: string, data: unknown): string {
  return html.replace(
    DATA_BLOCK,
    (_, open: string, __: string, close: string) => `${open}\n${scriptJson(data)}\n${close}`,
  );
}

/** HTML whitespace (the tokenizer's: tab, LF, FF, CR, space). */
const isWs = (c: number) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const SLASH = 47;
const GT = 62;
const EQ = 61;
const DQ = 34;
const SQ = 39;

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

/** One attribute as the tag scan read it: its name (lower case; '' for a
 *  name longer than any this module asks about), its raw value (null: no
 *  value; `undefined`: too costly to read, which every reader takes as a
 *  match) and where the next attribute of its tag starts (-1: the tag
 *  ends). */
type ScannedAttr = { name: string; value: string | null | undefined; next: number };

/**
 * The start tags of `html`, read as the HTML tokenizer reads a tag's
 * attributes (any case, any order, quoted or not, `/` between them), raw
 * (references not decoded). A superset: a tag is read at EVERY `<`
 * followed by a letter, inside comments, scripts and attribute values too,
 * so no element the browser makes is missed (text that only looks like a
 * tag adds one); prose with no `<` before it never counts.
 *
 * Linear in the length of `html`: where each run of name, value or white
 * space ends is worked out once, right to left; an attribute is read once
 * by where it starts (tags whose attributes meet share the rest: `attrs`
 * is keyed by position, `tags` holds each tag's first); and the values a
 * reader needs (ids, names, contents) are read within a budget of twice
 * the document, a value past it reading as `undefined` (a match: a
 * document built to be slow to read is refused, never misread).
 */
type TagScan = { attrs: Map<number, ScannedAttr>; tags: number[]; pidMeta?: boolean };
let lastScan: { html: string; scan: TagScan } | null = null;
const WANTED_NAMES = new Set(['id', 'name', 'content']);
function scanTags(html: string): TagScan {
  if (lastScan?.html === html) return lastScan.scan;
  const n = html.length;
  const code = (i: number) => html.charCodeAt(i);
  // Right to left: the first position at or after i where each run ends.
  const tagNameEnd = new Int32Array(n + 1);
  const attrNameEnd = new Int32Array(n + 1);
  const bareEnd = new Int32Array(n + 1);
  const pastWs = new Int32Array(n + 1);
  const pastWsSlash = new Int32Array(n + 1);
  const nextDq = new Int32Array(n + 1);
  const nextSq = new Int32Array(n + 1);
  tagNameEnd[n] = attrNameEnd[n] = bareEnd[n] = pastWs[n] = pastWsSlash[n] = n;
  nextDq[n] = nextSq[n] = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = code(i);
    const ws = isWs(c);
    tagNameEnd[i] = ws || c === SLASH || c === GT ? i : tagNameEnd[i + 1]!;
    attrNameEnd[i] = ws || c === SLASH || c === GT || c === EQ ? i : attrNameEnd[i + 1]!;
    bareEnd[i] = ws || c === GT ? i : bareEnd[i + 1]!;
    pastWs[i] = ws ? pastWs[i + 1]! : i;
    pastWsSlash[i] = ws || c === SLASH ? pastWsSlash[i + 1]! : i;
    nextDq[i] = c === DQ ? i : nextDq[i + 1]!;
    nextSq[i] = c === SQ ? i : nextSq[i + 1]!;
  }
  let budget = 2 * n + 65_536;
  const take = (from: number, to: number): string | undefined => {
    if (to - from > budget) return undefined;
    budget -= to - from;
    return html.slice(from, to);
  };
  const attrs = new Map<number, ScannedAttr>();
  /** Where an attribute starts after position i, or -1 when the tag ends. */
  const after = (i: number) => {
    const p = i < n ? pastWsSlash[i]! : n;
    return p >= n || code(p) === GT ? -1 : p;
  };
  const read = (first: number) => {
    for (let p = first; p !== -1 && !attrs.has(p);) {
      // The name: its first character may be `=`.
      const nameEnd = p + 1 < n ? attrNameEnd[p + 1]! : n;
      const name = nameEnd - p <= 7 ? html.slice(p, nameEnd).toLowerCase() : '';
      let i = nameEnd < n ? pastWs[nameEnd]! : n;
      let from = -1;
      let to = -1;
      if (i < n && code(i) === EQ) {
        i = i + 1 < n ? pastWs[i + 1]! : n;
        const q = i < n ? code(i) : -1;
        if (q === DQ || q === SQ) {
          const end = i + 1 < n ? (q === DQ ? nextDq : nextSq)[i + 1]! : -1;
          from = i + 1;
          to = end === -1 ? n : end;
          i = end === -1 ? n : end + 1;
        } else {
          from = i;
          to = i < n ? bareEnd[i]! : n;
          i = to;
        }
      }
      const value = from === -1 ? null : WANTED_NAMES.has(name) ? take(from, to) : '';
      const next = after(i);
      attrs.set(p, { name, value, next });
      p = next;
    }
  };
  const tags: number[] = [];
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    const c = at + 1 < n ? code(at + 1) : 0;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) continue;
    const first = after(tagNameEnd[at + 1]!);
    read(first);
    tags.push(first);
  }
  const scan: TagScan = { attrs, tags };
  lastScan = { html, scan };
  return scan;
}

/** The `id` values of every start tag in `html` (scanTags), each attribute
 *  once; `undefined` for one too costly to read. */
function idValues(html: string): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const a of scanTags(html).attrs.values())
    if (a.name === 'id' && a.value !== null) out.push(a.value);
  return out;
}

/** Whether an id could be the data block's to a browser. `loose` (a canvas
 *  that claims the `pid` template): the id once its character references
 *  are decoded, in any case, or any id with a reference in it that names a
 *  diagram (a named reference this check does not decode). Otherwise only
 *  an id `document.getElementById` finds: its numeric references and
 *  `&amp;` decoded, exactly (no named reference decodes to a letter or to
 *  `-`, so `diagram&amp;chart` is not one). An id too costly to read
 *  (`undefined`) is one. */
function dataBlockId(value: string | undefined, loose: boolean, id: string = DATA_ID): boolean {
  if (value === undefined) return true;
  const decoded = decodeRefs(value);
  if (!loose) return decoded === id;
  if (decoded.toLowerCase() === id) return true;
  return value.includes('&') && /diagram/i.test(decoded.replace(NAMED_REF, ''));
}

/** A named character reference (`&colon;`, `&commat`), which this module
 *  does not decode. */
const NAMED_REF = /&[A-Za-z][A-Za-z0-9]*;?/g;

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
 * Whether `data` (a canvas's parsed data block) is a `pid` drawing's: its
 * `template` is exactly `pid`. The one answer every reader gives: a save
 * (claimsPidTemplate), the tools (@mantle/tools templateOf) and the
 * runtime (browser.ts mount, which trusts a drawing's marks only then).
 * The head's meta never decides it.
 */
export function isPidData(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { template?: unknown }).template === 'pid'
  );
}

/** A canvas's template, as every reader decides it: its data block's
 *  `template` (a template name, `pid` exactly when isPidData), with the
 *  parsed data; null for a canvas whose block is missing, unreadable or
 *  names no template. Never the head's meta. */
export function canvasTemplate(
  html: string,
): { template: TemplateName; data: Record<string, unknown> } | null {
  let data: unknown;
  try {
    data = readCanvasData(html);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const template = (data as { template?: unknown }).template;
  return typeof template === 'string' && isTemplateName(template)
    ? { template, data: data as Record<string, unknown> }
    : null;
}

/** A head attribute value read loosely: its numeric references decoded,
 *  any named one read as `&`, standing for whichever character it names
 *  (no named reference is a letter or a digit), in lower case, trimmed. */
const looseText = (v: string) => decodeRefs(v).replace(NAMED_REF, '&').trim().toLowerCase();

/**
 * Whether a save holds a canvas to the `pid` template: its data block
 * names it (isPidData, the claim the runtime trusts), or, as a second
 * claim, any tag carries a `diagram:template` name whose content names
 * `pid` (read as `scanTags` reads, references decoded and named ones
 * read as any character, any case: a superset of the runtime's
 * `meta[name="diagram:template"]`). Such a canvas must be exactly what
 * buildCanvas writes (canonicalPidCanvas); any other canvas is the
 * author's own HTML, whose marks the runtime never trusts.
 */
export function claimsPidTemplate(html: string): boolean {
  try {
    if (isPidData(readCanvasData(html))) return true;
  } catch {
    // No readable block: the head may still claim it.
  }
  const scan = scanTags(html);
  return (scan.pidMeta ??= headClaimsPid(scan));
}

/** Whether a tag of the scan names the template and its content `pid`. */
function headClaimsPid({ attrs, tags }: TagScan): boolean {
  // Per attribute, whether its tag's attributes from here on name the
  // template and its content `pid` (positions grow along a tag, so right
  // to left each attribute reads its successor's answer).
  const named = new Map<number, boolean>();
  const pid = new Map<number, boolean>();
  for (const p of [...attrs.keys()].sort((a, b) => b - a)) {
    const a = attrs.get(p)!;
    const v = a.value;
    const isName =
      a.name === 'name' &&
      v !== null &&
      (v === undefined || /^diagram[:\s&]*template$/.test(looseText(v)));
    const isPid =
      a.name === 'content' &&
      v !== null &&
      (v === undefined || /^[\s&]*pid[\s&]*(?:@|&|$)/.test(looseText(v)));
    named.set(p, isName || (a.next !== -1 && named.get(a.next) === true));
    pid.set(p, isPid || (a.next !== -1 && pid.get(a.next) === true));
  }
  return tags.some((t) => t !== -1 && named.get(t) === true && pid.get(t) === true);
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

/** A canvas that claims the `pid` template whose data is past a size the
 *  template holds a drawing to (pidLimitsProblem): a save refuses it
 *  before any pass reads it. `problem` names the first, by its path. */
export class CanvasLimitsError extends Error {
  readonly problem: string;
  constructor(problem: string) {
    super(`canvas: the pid data is over a limit (${problem})`);
    this.problem = problem;
    this.name = 'CanvasLimitsError';
  }
}

/** A regular expression source for `s`, literally. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The shape of a `pid` canvas as buildCanvas writes it, its variable parts
 * captured, white space between tags free: the head's title text (1) and
 * description (2, absent when the canvas has none), the data block's JSON
 * (3), the assets block's JSON (4, absent when the canvas embeds no
 * crops; right after the data block) and the runtime (5: the import of
 * the shipped runtime, or one inline classic script, which a save
 * replaces with the import). Built from the one writer
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
      assetsHtml: mark('A'),
      runtime: mark('R'),
    }),
  );
  const desc = literal(`\n<meta name="description" content="${mark('D')}">`);
  const assets = literal(`\n${mark('A')}`);
  src = src
    .replace(desc, '(?:\\s*<meta name="description" content="([^"<>]*)">)?')
    .replace(
      assets,
      `(?:\\s*${literal(`<script type="application/json" id="${ASSETS_ID}">`)}([^<]*)<\\/script>)?`,
    )
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
 * markup), its embedded crops as `parseCanvasAssets` reads them (a save
 * then keeps only the sealed ones a kept mark names:
 * withSealedCanvasAssets) and the shipped runtime by import. Null when `html` holds
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
    assetsHtml: m[4] !== undefined ? assetsBlock(parseCanvasAssets(m[4])) : '',
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
 * counts recounted; one that holds anything else throws CanvasShapeError,
 * and one whose data is past a size the template holds a drawing to
 * (pidLimitsProblem, checked before any pass reads the data) throws
 * CanvasLimitsError.
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
  if (!claimsPidTemplate(html)) return replaceDataBlock(html, data);
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new CanvasShapeError();
  // The sizes first: no normalizing pass runs on data past them.
  const problem = pidLimitsProblem(data);
  if (problem !== null) throw new CanvasLimitsError(problem);
  const honest = honestImageChecks(data as Record<string, unknown>, holds);
  const own = imageChecksStale(honest) ? withImageCheckSummary(honest) : honest;
  const out = canonicalPidCanvas(html, own);
  if (out === null) throw new CanvasShapeError();
  return out;
}

/** Every assets block as this package writes it: as the data block, its
 *  JSON never holds a `<` (scriptSafe), so the block ends at the first
 *  `<` (and a scan is linear). */
const ASSETS_BLOCK_SRC = `<script type="application/json" id="${ASSETS_ID}">([^<]*)</script>`;
const ASSETS_BLOCKS = new RegExp(`${ASSETS_BLOCK_SRC}\\n?`, 'g');

/** A crop data URL the view may show, or null: a base64 PNG, JPEG or WebP
 *  under the size cap, nothing else (no SVG, no markup, no URL). */
const CROP_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export function safeCropUrl(v: unknown): string | null {
  return typeof v === 'string' && v.length <= CROP_LIMITS.urlChars && CROP_URL.test(v) ? v : null;
}

/**
 * An assets block's text, read: each crop keyed by its file id (lower
 * case), kept only when its id is a file id and its picture one the view
 * may show (`safeCropUrl`). The one reader: the save (readCanvasAssets,
 * withSealedCanvasAssets) and the frame (evidence.ts readCrops) both use
 * it. The seal is read, not checked: a save checks it, the frame trusts
 * what a save stored.
 */
export function parseCanvasAssets(text: string | null | undefined): CanvasAssets {
  const crops: Record<string, CanvasCrop> = {};
  if (!text) return { crops };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { crops };
  }
  const raw = (v as { crops?: unknown } | null)?.crops;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { crops };
  for (const [id, c] of Object.entries(raw as Record<string, unknown>)) {
    if (!FILE_ID.test(id) || !c || typeof c !== 'object') continue;
    const src = safeCropUrl((c as { src?: unknown }).src);
    const sig = (c as { sig?: unknown }).sig;
    if (src && typeof sig === 'string' && sig.length <= 128) crops[id.toLowerCase()] = { src, sig };
  }
  return { crops };
}

/** The canvas's embedded pictures (its first assets block), or none. */
export function readCanvasAssets(html: string): CanvasAssets {
  return parseCanvasAssets(new RegExp(ASSETS_BLOCK_SRC).exec(html)?.[1]);
}

/** The same canvas with its embedded pictures replaced (none: the blocks
 *  go, every one). The block sits right after the data block. */
export function replaceCanvasAssets(html: string, assets: CanvasAssets | null): string {
  const out = html.replace(ASSETS_BLOCKS, '');
  const block = assetsBlock(assets);
  if (!block) return out;
  const m = DATA_BLOCK.exec(out);
  if (!m) throw new Error('canvas: no data block to put the assets after');
  const end = m.index + m[0].length;
  return `${out.slice(0, end)}\n${block}${out.slice(end)}`;
}

/** As `dataBlockCount`, for the assets block: how many elements carry its
 *  id in any form a browser reads (the same tag reading, `idValues`; the
 *  same `loose`, the default, for a canvas that claims the `pid`
 *  template), and how many blocks it holds as this package writes them. A
 *  save refuses a canvas where they differ (one written another way would
 *  hold pictures no save checked); the blocks it can read it rewrites in
 *  its own form (withSealedCanvasAssets). */
export function assetsBlockCount(
  html: string,
  opts: { loose?: boolean } = {},
): { any: number; written: number } {
  const loose = opts.loose ?? true;
  const any = idValues(html).filter((v) => dataBlockId(v, loose, ASSETS_ID)).length;
  const written = html.match(new RegExp(ASSETS_BLOCK_SRC, 'g'));
  return { any, written: written?.length ?? 0 };
}

/** Every crop file id the checks in `pid` data name (one drawing or a
 *  set: a connector's and an inline item's `check.crops`, a line's
 *  `checks[].crops`), in order, each once, lower case. Only file ids. */
export function checkCropIds(data: unknown): string[] {
  const out: string[] = [];
  const take = (check: unknown) => {
    const crops = (check as { crops?: unknown } | null)?.crops;
    if (!Array.isArray(crops)) return;
    for (const id of crops)
      if (typeof id === 'string' && FILE_ID.test(id) && !out.includes(id.toLowerCase()))
        out.push(id.toLowerCase());
  };
  mapDrawings(data, (d) => mapImageChecks(d, (c) => (take(c), c)));
  return out;
}

/** Every crop file id the checks in `pid` data name with the sha256 its
 *  mark records for it (`cropSha`, in the order of `crops`), lower case:
 *  the bytes circuit_verify stored, the only ones a crop of that id may be
 *  made from. An id no mark records a hash for is not in the map. */
export function checkCropShas(data: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const take = (check: unknown) => {
    const c = check as { crops?: unknown; cropSha?: unknown } | null;
    if (!Array.isArray(c?.crops) || !Array.isArray(c.cropSha)) return;
    if (c.crops.length !== c.cropSha.length) return;
    c.crops.forEach((id, i) => {
      const sha = (c.cropSha as unknown[])[i];
      if (typeof id !== 'string' || !FILE_ID.test(id)) return;
      if (typeof sha !== 'string' || !SHA256.test(sha)) return;
      const k = id.toLowerCase();
      const set = out.get(k) ?? new Set<string>();
      set.add(sha);
      out.set(k, set);
    });
  };
  mapDrawings(data, (d) => mapImageChecks(d, (c) => (take(c), c)));
  return out;
}

/** Whether `sig` is the server's seal of a crop (`cropSealPayload` under
 *  CROP_SEAL_PURPOSE) for this file id and picture, made from the file
 *  bytes whose sha256 is `sourceSha`; the content layer passes it (it
 *  hashes the bytes and holds the key). */
export type CropSealCheck = (
  fileId: string,
  src: string,
  sig: string,
  sourceSha: string,
) => boolean;

/**
 * A canvas's assets as a save stores them (@mantle/content honestCanvasSource,
 * after withHonestImageChecks): every written assets block folded into
 * one, keeping only crops a surviving mark of the data names with the
 * sha256 of the bytes circuit_verify stored (`checkCropShas`: the marks
 * the save kept, so an unsealed claim lost its crops) and whose seal holds
 * for those bytes.
 * Byte for byte unchanged when nothing is dropped. The caller refuses a
 * canvas with an assets block written another way first
 * (`assetsBlockCount`).
 */
export function withSealedCanvasAssets(html: string, holds: CropSealCheck): string {
  const blocks = [...html.matchAll(new RegExp(ASSETS_BLOCK_SRC, 'g'))];
  if (!blocks.length) return html;
  // Crops only a `pid` canvas's marks name (any other canvas keeps none).
  let data: unknown = null;
  if (claimsPidTemplate(html)) {
    try {
      data = readCanvasData(html);
    } catch {
      data = null;
    }
  }
  // A crop is kept only where a kept mark names it with the hash of the
  // bytes circuit_verify stored, and its seal binds those bytes.
  const named = checkCropShas(data);
  const crops: Record<string, CanvasCrop> = {};
  for (const b of blocks)
    for (const [id, c] of Object.entries(parseCanvasAssets(b[1]).crops)) {
      if (id in crops) continue;
      const shas = named.get(id);
      if (shas && [...shas].some((sha) => holds(id, c.src, c.sig, sha))) crops[id] = c;
    }
  const kept: CanvasAssets | null = Object.keys(crops).length ? { crops } : null;
  if (blocks.length === 1 && blocks[0]![0] === assetsBlock(kept)) return html;
  return DATA_BLOCK.test(html) ? replaceCanvasAssets(html, kept) : html.replace(ASSETS_BLOCKS, '');
}

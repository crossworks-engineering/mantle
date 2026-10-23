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

const DATA_BLOCK = new RegExp(
  `(<script type="application/json" id="${DATA_ID}">)([\\s\\S]*?)(</script>)`,
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
    out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(data.title)}</title>`);
  if (typeof data.description === 'string') {
    out = out.replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(data.description)}">`,
    );
  }
  return out;
}

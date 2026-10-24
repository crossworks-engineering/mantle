/**
 * Present canvases (docs/proposals/canvas-files.md section 4.2): one
 * self-contained HTML document per item. This module reads a canvas WITHOUT
 * running it: the head contract (title, description, design size, theme),
 * the visible text search and the extractor index, and the library imports.
 *
 * Pure and dependency free (no DOM, no parser package), so the brain, the
 * tools and the client read a canvas the same way. It is a reader for
 * well-formed agent-written HTML, not a sanitiser: nothing here makes a
 * canvas safe to run. The sandboxed frame does that (section 5.2).
 */

/** The largest canvas source the brain stores (section 4.1). */
export const CANVAS_MAX_BYTES = 1_000_000;

/** The design size a fixed canvas is drawn at when its head names none. */
export const CANVAS_DEFAULT_SIZE = { w: 1600, h: 900 } as const;

/** How the frame fits a canvas: a fixed design size scaled to the space with
 *  letterboxing, or the whole viewport (`canvas:size="fill"`). */
export type CanvasSize = { w: number; h: number } | 'fill';

export type CanvasHead = {
  /** `<title>`, or '' when the head has none. */
  title: string;
  /** `<meta name="description">`, or ''. */
  description: string;
  size: CanvasSize;
  /** 'fixed' pins the light palette (`canvas:theme="fixed"`); 'follow' takes
   *  the owner's theme. */
  theme: 'follow' | 'fixed';
  /** When to take the poster of an animation, in seconds, or null. */
  posterAt: number | null;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  copy: '(c)',
  deg: '°',
};

/** Decode the character references agent HTML commonly holds. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z]{1,32});/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** The value of an attribute in one tag's source, or null. */
function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/** Every `<meta name=... content=...>` of the document, by lower-case name. */
function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attrOf(m[0], 'name');
    const content = attrOf(m[0], 'content');
    if (name && content !== null && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), content.trim());
    }
  }
  return out;
}

/** `1600x900` → { w, h } within sane bounds, `fill` → 'fill', else null. */
export function parseCanvasSize(value: string | null | undefined): CanvasSize | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'fill') return 'fill';
  const m = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(v);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 100 || h < 100 || w > 8000 || h > 8000) return null;
  return { w, h };
}

/** `2.5s`, `2500ms` or `2.5` → seconds, within 0..60, else null. */
function parseSeconds(value: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec((value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]) / (m[2]?.toLowerCase() === 'ms' ? 1000 : 1);
  return n >= 0 && n <= 60 ? n : null;
}

// Every reader below is a linear scan (indexOf, and regexes bounded to one
// tag or a short window), never a backtracking regex over the document: a
// canvas is written by an agent that may be steered, and a save, a search
// index or a frame load must not be held up by a document built to make a
// regex run for minutes (the canvas audit, 2026-10-24).

/** The tags whose content is never visible text. */
const HIDDEN_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** The tag name at `<` (lower case), or null. Reads at most 40 characters. */
function tagNameAt(html: string, lt: number): string | null {
  const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 40));
  return m ? m[1]!.toLowerCase() : null;
}

/** The index just past the `>` that closes `</name ...>` from `from`, or
 *  the end of the text when there is none. `lower` is the text in lower case. */
function pastClose(lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  if (close < 0) return lower.length;
  const gt = lower.indexOf('>', close);
  return gt < 0 ? lower.length : gt + 1;
}

/** Comments, scripts, styles and other non-visible blocks removed. */
function withoutHiddenBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      out += ' ';
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const name = tagNameAt(html, lt);
    if (name && HIDDEN_TAGS.has(name)) {
      out += ' ';
      i = pastClose(lower, name, lt + 1 + name.length);
      continue;
    }
    out += '<';
    i = lt + 1;
  }
  return out;
}

/** Every `<...>` replaced by a space, in one pass. (`/<[^>]+>/g` reads to
 *  the end of the text from each `<` that has no `>` after it.) */
function withoutTags(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    out += ' ';
    i = gt + 1;
  }
  return out;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The most of the document the head is looked for in. */
const HEAD_SCAN_MAX = 64_000;

/** The document's head (from `<head` to `</head>`, else the first
 *  HEAD_SCAN_MAX characters). */
function headOf(html: string): string {
  const window = html.slice(0, HEAD_SCAN_MAX);
  const lower = window.toLowerCase();
  const open = lower.indexOf('<head');
  if (open < 0) return window;
  const close = lower.indexOf('</head', open);
  return window.slice(open, close < 0 ? window.length : close);
}

/** The text inside the head's `<title>`, or ''. */
function titleOf(head: string): string {
  const lower = head.toLowerCase();
  const open = lower.indexOf('<title');
  if (open < 0) return '';
  const gt = lower.indexOf('>', open);
  if (gt < 0) return '';
  const close = lower.indexOf('</title', gt);
  return head.slice(gt + 1, close < 0 ? Math.min(head.length, gt + 1 + 400) : close);
}

/** Read a canvas's head contract (section 4.2). Missing parts take their
 *  defaults: no title is '', no size is the default design size. */
export function parseCanvasHead(html: string): CanvasHead {
  const head = headOf(html);
  const metas = metaTags(head);
  return {
    title: collapse(decodeHtmlEntities(titleOf(head))).slice(0, 200),
    description: collapse(metas.get('description') ?? '').slice(0, 500),
    size: parseCanvasSize(metas.get('canvas:size')) ?? { ...CANVAS_DEFAULT_SIZE },
    theme: metas.get('canvas:theme')?.toLowerCase() === 'fixed' ? 'fixed' : 'follow',
    posterAt: parseSeconds(metas.get('canvas:poster-at')),
  };
}

/** The most text a canvas contributes to search and the extractor. */
export const CANVAS_TEXT_MAX = 20_000;

/** The document's body (after `<body ...>`, up to the last `</body`), else
 *  the whole document. */
function bodyOf(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf('<body');
  if (open < 0) return html;
  const gt = lower.indexOf('>', open);
  if (gt < 0) return html;
  const close = lower.lastIndexOf('</body');
  return html.slice(gt + 1, close > gt ? close : html.length);
}

/**
 * The canvas's derived text (section 4.3): title, description, then the
 * visible text of the body, with scripts, styles and comments removed.
 * Deterministic, so an unchanged canvas yields the same text and a save that
 * only moves a colour changes nothing the index reads.
 */
export function canvasText(html: string): string {
  const { title, description } = parseCanvasHead(html);
  const visible = collapse(
    decodeHtmlEntities(
      // Tags become spaces so words in adjacent cells never fuse.
      withoutTags(withoutHiddenBlocks(bodyOf(html))),
    ),
  );
  return [title, description, visible]
    .filter((s) => s.length > 0)
    .join('\n')
    .slice(0, CANVAS_TEXT_MAX);
}

/** How far after `import` or `export` a specifier is looked for. */
const IMPORT_WINDOW = 400;

/** The specifiers one module script imports, each statement read within a
 *  short window after its keyword. */
function moduleSpecifiers(code: string): string[] {
  const out: string[] = [];
  const keyword = /\b(import|export)\b/g;
  let k: RegExpExecArray | null;
  while ((k = keyword.exec(code))) {
    const window = code.slice(k.index, k.index + IMPORT_WINDOW);
    const m =
      k[1] === 'import'
        ? (/^import\s*\(\s*["']([^"'\n]+)["']\s*\)/.exec(window) ??
          /^import\s*["']([^"'\n]+)["']/.exec(window) ??
          /^import\b[^"';]*?\bfrom\s*["']([^"'\n]+)["']/.exec(window))
        : /^export\b[^"';]*?\bfrom\s*["']([^"'\n]+)["']/.exec(window);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * The module specifiers a canvas imports (`import x from 'd3'`,
 * `import 'motion'`, `import('three')`), and the classic script sources it
 * loads, deduplicated in order. The save step records the library names
 * (meta.libs); a later phase refuses a name outside the vendored set.
 */
export function canvasImports(html: string): { modules: string[]; scripts: string[] } {
  const modules: string[] = [];
  const scripts: string[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const open = lower.indexOf('<script', i);
    if (open < 0) break;
    const gt = lower.indexOf('>', open);
    if (gt < 0) break;
    const attrs = `<script ${html.slice(open + 7, gt)}>`;
    const close = lower.indexOf('</script', gt);
    const code = html.slice(gt + 1, close < 0 ? html.length : close);
    i = close < 0 ? html.length : close + 8;
    const src = attrOf(attrs, 'src');
    if (src) {
      if (!scripts.includes(src)) scripts.push(src);
      continue;
    }
    if ((attrOf(attrs, 'type') ?? '').toLowerCase() !== 'module') continue;
    for (const spec of moduleSpecifiers(code)) if (!modules.includes(spec)) modules.push(spec);
  }
  return { modules, scripts };
}

/** The path classic scripts and stylesheets of the vendored set sit under. */
export const CANVAS_RUNTIME_PREFIX = '/canvas-runtime/';

/** `src` and `href` values of the document's tags, in order (bounded scan). */
function urlAttributes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(
    /<(?:script|link|img|source|audio|video|iframe|embed|object)\b[^>]{0,2000}>/gi,
  )) {
    for (const name of ['src', 'href', 'data', 'poster']) {
      const v = attrOf(m[0], name);
      if (v !== null) out.push(v.trim());
    }
  }
  return out;
}

/**
 * What would make a canvas fail in its frame, found before it is saved
 * (section 6.2): a module the vendored set does not have, a classic script
 * or stylesheet outside `/canvas-runtime/` and `/share-runtime/`, or any URL
 * to another host (the frame refuses the network, so it would only ever be
 * blank). `modules` is the import map's specifiers. Each problem names the
 * fix; the caller refuses the save with the list.
 */
export function canvasLoadProblems(html: string, modules: readonly string[]): string[] {
  const problems: string[] = [];
  const known = new Set(modules);
  const { modules: imported } = canvasImports(html);
  for (const spec of imported) {
    if (known.has(spec)) continue;
    if (/^(https?:)?\/\//i.test(spec)) {
      problems.push(
        `import '${spec}': the frame has no network. Import a library by its bare name instead: ${modules.join(', ')}.`,
      );
    } else {
      problems.push(
        `import '${spec}': not in the canvas library set. Use one of: ${modules.join(', ')}; or plain SVG and JS.`,
      );
    }
  }
  for (const url of urlAttributes(html)) {
    if (!url || url.startsWith('#') || /^(data|blob):/i.test(url)) continue;
    if (/^(https?:)?\/\//i.test(url)) {
      problems.push(
        `'${url.slice(0, 120)}': the frame has no network, so nothing loads from another host. Inline it (a data: URL, inline SVG) or use the vendored set.`,
      );
      continue;
    }
    if (url.startsWith(CANVAS_RUNTIME_PREFIX) || url.startsWith('/share-runtime/')) continue;
    problems.push(
      `'${url.slice(0, 120)}': only files under ${CANVAS_RUNTIME_PREFIX} (for example ${CANVAS_RUNTIME_PREFIX}plotly/plotly.min.js) load in a canvas. Inline anything else.`,
    );
  }
  return [...new Set(problems)];
}

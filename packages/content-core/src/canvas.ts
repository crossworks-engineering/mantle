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
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
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

/** Comments, scripts, styles and other non-visible blocks removed. */
function withoutHiddenBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg:style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Read a canvas's head contract (section 4.2). Missing parts take their
 *  defaults: no title is '', no size is the default design size. */
export function parseCanvasHead(html: string): CanvasHead {
  const head = /<head\b[\s\S]*?<\/head\s*>/i.exec(html)?.[0] ?? html;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const metas = metaTags(head);
  return {
    title: collapse(decodeHtmlEntities(titleMatch?.[1] ?? '')).slice(0, 200),
    description: collapse(metas.get('description') ?? '').slice(0, 500),
    size: parseCanvasSize(metas.get('canvas:size')) ?? { ...CANVAS_DEFAULT_SIZE },
    theme: metas.get('canvas:theme')?.toLowerCase() === 'fixed' ? 'fixed' : 'follow',
    posterAt: parseSeconds(metas.get('canvas:poster-at')),
  };
}

/** The most text a canvas contributes to search and the extractor. */
export const CANVAS_TEXT_MAX = 20_000;

/**
 * The canvas's derived text (section 4.3): title, description, then the
 * visible text of the body, with scripts, styles and comments removed.
 * Deterministic, so an unchanged canvas yields the same text and a save that
 * only moves a colour changes nothing the index reads.
 */
export function canvasText(html: string): string {
  const { title, description } = parseCanvasHead(html);
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
  const visible = collapse(
    decodeHtmlEntities(
      withoutHiddenBlocks(body)
        // Block ends become spaces so words in adjacent cells never fuse.
        .replace(/<[^>]+>/g, ' '),
    ),
  );
  return [title, description, visible]
    .filter((s) => s.length > 0)
    .join('\n')
    .slice(0, CANVAS_TEXT_MAX);
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
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = `<script ${m[1] ?? ''}>`;
    const src = attrOf(attrs, 'src');
    if (src) {
      if (!scripts.includes(src)) scripts.push(src);
      continue;
    }
    if ((attrOf(attrs, 'type') ?? '').toLowerCase() !== 'module') continue;
    const code = m[2] ?? '';
    const found = [
      ...code.matchAll(/\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g),
      ...code.matchAll(/\bexport\s+[\w*{}\s,$]+?\s+from\s+["']([^"']+)["']/g),
      ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const f of found) {
      const spec = f[1]!;
      if (!modules.includes(spec)) modules.push(spec);
    }
  }
  return { modules, scripts };
}

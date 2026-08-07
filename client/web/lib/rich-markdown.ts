/**
 * Convert Saskia's "rich markdown" dialect into the HTML the Pages TipTap
 * schema (`pageExtensions`) knows how to parse. The chat renders Saskia's
 * replies through the SAME editor schema the Pages surface uses, so she can
 * write callouts, columns, task lists, tables and highlights and have them
 * render identically to a page.
 *
 * The dialect is plain GFM markdown plus three container constructs that don't
 * exist in markdown, chosen so the model can emit them reliably and so they map
 * 1:1 onto the custom TipTap nodes (callout / columnList+column) whose
 * `parseHTML` rules key off `data-*` attributes:
 *
 *   Callout (variant ∈ info | success | warning | danger):
 *     :::info
 *     **Heads up** — body markdown here.
 *     :::
 *
 *   Columns (2+ columns, split by a line of `+++`):
 *     :::columns
 *     ### Left
 *     content
 *     +++
 *     ### Right
 *     content
 *     :::
 *
 *   Task list (GFM checkboxes — emitted as TipTap taskList markup):
 *     - [ ] open item
 *     - [x] done item
 *
 *   Highlight:  ==marked text==  → <mark>.
 *
 *   Colour:  [text]{color=chart-2} / [text]{highlight=chart-3}  (chart-1..5) →
 *     a themed text colour and/or highlight (both keys may appear in one span).
 *
 *   Stored image:  ![alt](media:<file-id>)  → the uploaded file's picture,
 *     placed exactly where it was written. This is what lets a reply put a
 *     screenshot beside the step it belongs to instead of clumping every
 *     picture in a gallery underneath. Same syntax the Pages dialect uses; the
 *     scheme itself is shared (@mantle/content/markdown-refs) so the two
 *     converters cannot drift apart again.
 *
 * Containers are parsed by a top-level line walk (they aren't markdown); every
 * other run is handed to `marked`. Nesting containers inside containers isn't
 * supported in v1 — callouts hold simple block content, which covers the cases
 * that matter. The output is fed to a read-only TipTap editor (see
 * `components/assistant/rich-text.tsx`), so anything the schema can't parse is
 * dropped gracefully rather than shown raw.
 */
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import { drawNodeId, drawRawSrc, fileRawSrc, mediaFileId } from '@mantle/content/markdown-refs';

const CALLOUT_VARIANTS = ['info', 'success', 'warning', 'danger'] as const;
type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

// `==highlight==` → <mark>, as a proper inline extension so it's never applied
// inside code spans / fenced blocks (marked tokenizes those first).
const highlightExtension: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline',
  start(src) {
    return src.indexOf('==');
  },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!m) return undefined;
    return {
      type: 'highlight',
      raw: m[0],
      text: m[1]!,
      tokens: this.lexer.inlineTokens(m[1]!),
    };
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
  },
};

// `[text]{color=chart-2}` / `[text]{highlight=chart-3}` → themed text-colour +
// highlight marks. Emits the `data-*` attrs the Pages schema parses
// (TextColor → span[data-text-color], Highlight → mark[data-color]); chart-1..5.
const COLOR_TOKEN_RE = /^chart-[1-5]$/;
function parseColorAttrs(attrStr: string): { color?: string; highlight?: string } {
  const res: { color?: string; highlight?: string } = {};
  for (const part of attrStr.trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if ((key === 'color' || key === 'highlight') && COLOR_TOKEN_RE.test(val)) res[key] = val;
  }
  return res;
}
const colorSpanExtension: TokenizerAndRendererExtension = {
  name: 'colorSpan',
  level: 'inline',
  start(src) {
    return src.indexOf('[');
  },
  tokenizer(src) {
    const m = /^\[([\s\S]*?\S)\]\{([^}]+)\}/.exec(src);
    if (!m) return undefined;
    const { color, highlight } = parseColorAttrs(m[2]!);
    if (!color && !highlight) return undefined; // not a colour span — let link/text handle it
    return {
      type: 'colorSpan',
      raw: m[0],
      text: m[1]!,
      tokens: this.lexer.inlineTokens(m[1]!),
      color,
      highlight,
    };
  },
  renderer(token) {
    let html = this.parser.parseInline(token.tokens ?? []);
    const highlight = typeof token.highlight === 'string' ? token.highlight : '';
    const color = typeof token.color === 'string' ? token.color : '';
    if (highlight) html = `<mark data-color="${escapeAttr(highlight)}">${html}</mark>`;
    if (color) html = `<span data-text-color="${escapeAttr(color)}">${html}</span>`;
    return html;
  },
};

// Inline `$…$` → a KaTeX inline-math span the Mathematics extension parses
// (`[data-type="inline-math"]`, latex from `data-latex`). Block `$$…$$` is
// handled at line level in richMarkdownToHtml.
const inlineMathExtension: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    return src.indexOf('$');
  },
  tokenizer(src) {
    const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src);
    if (!m) return undefined;
    return { type: 'inlineMath', raw: m[0], latex: m[1]! };
  },
  renderer(token) {
    const latex = typeof token.latex === 'string' ? token.latex : '';
    return `<span data-type="inline-math" data-latex="${escapeAttr(latex)}"></span>`;
  },
};

// `![alt](media:<file-id>)` → the stored file's picture, INLINE where it was
// written. Registered as an inline extension (custom inline tokenizers run
// before marked's built-ins) rather than a renderer override, so a non-`media:`
// image still takes the default path untouched.
//
// The emitted tag must carry a real `src`: PageImage.parseHTML is
// `[{ tag: 'img[src]' }]`, and a bare `<img data-node-id>` would not be parsed
// as an image at all. Once parsed, the node re-derives its own src from
// `data-node-id` (through assetUrl, so a detached client loads it from the
// remote origin), which is why `fileRawSrc` is shared with that code path.
//
// `image` is a BLOCK node in the shared schema, so ProseMirror's DOM parser
// closes the surrounding paragraph and places it as its own block, the same
// outcome markdownToDoc reaches via `paragraphAndImages`. That is the point of
// the drift test: one dialect, two renderers, one answer.
const mediaImageExtension: TokenizerAndRendererExtension = {
  name: 'mediaImage',
  level: 'inline',
  start(src) {
    return src.indexOf('![');
  },
  tokenizer(src) {
    const m = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/.exec(src);
    if (!m) return undefined;
    const nodeId = mediaFileId(m[2]);
    // `draw:` resolves here too. If it fell through to marked it would render
    // <img src="draw:…">, which is the exact divergence this file exists to
    // prevent (see the header) — Pages resolving a scheme that chat does not.
    const drawId = drawNodeId(m[2]);
    // Any other href (http, data, a relative path) is an ordinary markdown
    // image. Hand it back to marked's own tokenizer.
    if (!nodeId && !drawId) return undefined;
    return { type: 'mediaImage', raw: m[0], text: m[1] ?? '', nodeId, drawId };
  },
  renderer(token) {
    const nodeId = typeof token.nodeId === 'string' ? token.nodeId : '';
    const drawId = typeof token.drawId === 'string' ? token.drawId : '';
    const alt = typeof token.text === 'string' ? token.text : '';
    if (drawId) return drawImageHtml(drawId, alt);
    if (!nodeId) return '';
    return mediaImageHtml(nodeId, alt);
  },
};

/** The `<img>` for a stored file. One spelling for both entry points: the
 *  line-level standalone form and the inline-in-prose extension above. */
function mediaImageHtml(nodeId: string, alt: string): string {
  return `<img src="${escapeAttr(fileRawSrc(nodeId))}" data-node-id="${escapeAttr(
    nodeId,
  )}" alt="${escapeAttr(alt)}">`;
}

/** The `<img>` for an embedded drawing's committed snapshot. Same shape as
 *  mediaImageHtml — always an image element, never inline SVG markup. */
function drawImageHtml(drawId: string, alt: string): string {
  return `<img src="${escapeAttr(drawRawSrc(drawId))}" data-draw-id="${escapeAttr(
    drawId,
  )}" alt="${escapeAttr(alt)}">`;
}

// One configured instance (module singleton) so we don't re-register the
// extensions on every call. GFM gives us tables + strikethrough.
const md = new Marked({ gfm: true });
md.use({
  extensions: [highlightExtension, colorSpanExtension, inlineMathExtension, mediaImageExtension],
});

const BLOCK_MATH_INLINE = /^\$\$(.+?)\$\$\s*$/;

// A `![alt](media:<id>)` alone on an unindented line, the form the skill
// teaches for a walkthrough. Lifted at the line level (like the `:::` fences)
// rather than through `marked`, which would wrap it in a `<p>`: ProseMirror
// then closes that paragraph EMPTY before opening the block image, leaving a
// blank line above every picture. markdownToDoc emits the bare image node, so
// this is what keeps the two in step. An INDENTED marker (inside a list item)
// is left to marked, which keeps it in its item.
const MEDIA_IMAGE_LINE_RE = /^!\[([^\]]*)\]\(\s*media:([^\s)]+)(?:\s+"[^"]*")?\s*\)\s*$/;

const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
// Optional trailing token carries an aside's themed colour (`:::aside chart-3`).
const FENCE_OPEN_RE = /^:::([A-Za-z]+)(?:\s+([A-Za-z0-9-]+))?\s*$/;
const ASIDE_COLORS = new Set(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']);

// Attribute-value escaping. `&` first, or the entities below get double-escaped.
// `<`/`>` aren't strictly required inside a quoted value, but escaping them
// keeps a malformed alt (`![a"><b](media:…)`) from being able to close the tag
// early. The output is parsed by a real DOM parser before ProseMirror sees it.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  return md.parseInline(text) as string;
}

function renderBlocks(text: string): string {
  return md.parse(text) as string;
}

function renderCallout(variant: CalloutVariant, bodyLines: string[]): string {
  const inner = renderBlocks(bodyLines.join('\n').trim()) || '<p></p>';
  return `<div data-callout data-variant="${escapeAttr(variant)}">${inner}</div>`;
}

function renderAside(color: string, bodyLines: string[]): string {
  const inner = renderBlocks(bodyLines.join('\n').trim()) || '<p></p>';
  // data-color/data-angle round-trip into the Aside NodeView, which paints the
  // themed gradient from the attrs. Default angle (135) is applied by the node.
  return `<div data-aside data-color="${escapeAttr(color)}">${inner}</div>`;
}

function renderColumns(bodyLines: string[]): string {
  // Split the body into column segments on a lone `+++` line.
  const segments: string[][] = [[]];
  for (const line of bodyLines) {
    if (/^\+\+\+\s*$/.test(line.trim())) segments.push([]);
    else segments[segments.length - 1]!.push(line);
  }
  const cols = segments.map((seg) => seg.join('\n').trim()).filter((s) => s.length > 0);
  // The schema requires 2+ columns; degrade a 0/1-column block to plain blocks.
  if (cols.length < 2) return renderBlocks(bodyLines.join('\n').trim());
  const inner = cols.map((c) => `<div data-column>${renderBlocks(c) || '<p></p>'}</div>`).join('');
  return `<div data-column-list>${inner}</div>`;
}

function renderTaskList(items: Array<{ checked: boolean; text: string }>): string {
  const lis = items
    .map(
      (it) =>
        `<li data-type="taskItem" data-checked="${it.checked ? 'true' : 'false'}"><p>${renderInline(
          it.text,
        )}</p></li>`,
    )
    .join('');
  return `<ul data-type="taskList">${lis}</ul>`;
}

export function richMarkdownToHtml(source: string): string {
  if (!source?.trim()) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) {
      const html = renderBlocks(plain.join('\n'));
      if (html.trim()) out.push(html);
      plain = [];
    }
  };

  const blockMathHtml = (latex: string) =>
    `<div data-type="block-math" data-latex="${escapeAttr(latex)}"></div>`;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Block math: `$$ … $$` on one line, or a `$$` fence over several lines.
    const oneLineMath = BLOCK_MATH_INLINE.exec(line.trim());
    if (oneLineMath) {
      flush();
      out.push(blockMathHtml(oneLineMath[1]!.trim()));
      i++;
      continue;
    }
    if (line.trim() === '$$') {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== '$$') {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing $$
      out.push(blockMathHtml(body.join('\n').trim()));
      continue;
    }

    const fence = FENCE_OPEN_RE.exec(line.trim());
    if (fence) {
      flush();
      const kind = fence[1]!.toLowerCase();
      const arg = fence[2]?.toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== ':::') {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing :::
      if (kind === 'columns') out.push(renderColumns(body));
      else if (kind === 'aside')
        out.push(renderAside(arg && ASIDE_COLORS.has(arg) ? arg : 'chart-1', body));
      else if ((CALLOUT_VARIANTS as readonly string[]).includes(kind))
        out.push(renderCallout(kind as CalloutVariant, body));
      else out.push(renderCallout('info', body));
      continue;
    }

    const mediaLine = MEDIA_IMAGE_LINE_RE.exec(line);
    if (mediaLine) {
      flush();
      out.push(mediaImageHtml(mediaLine[2]!, mediaLine[1] ?? ''));
      i++;
      continue;
    }

    if (TASK_RE.test(line)) {
      flush();
      const items: Array<{ checked: boolean; text: string }> = [];
      while (i < lines.length) {
        const m = TASK_RE.exec(lines[i]!);
        if (!m) break;
        items.push({ checked: m[1]!.toLowerCase() === 'x', text: m[2]! });
        i++;
      }
      out.push(renderTaskList(items));
      continue;
    }

    plain.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

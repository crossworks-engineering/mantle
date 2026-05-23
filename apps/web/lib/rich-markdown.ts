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
 * Containers are parsed by a top-level line walk (they aren't markdown); every
 * other run is handed to `marked`. Nesting containers inside containers isn't
 * supported in v1 — callouts hold simple block content, which covers the cases
 * that matter. The output is fed to a read-only TipTap editor (see
 * `components/assistant/rich-text.tsx`), so anything the schema can't parse is
 * dropped gracefully rather than shown raw.
 */
import { Marked, type TokenizerAndRendererExtension } from 'marked';

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

// One configured instance (module singleton) so we don't re-register the
// highlight extension on every call. GFM gives us tables + strikethrough.
const md = new Marked({ gfm: true });
md.use({ extensions: [highlightExtension] });

const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const FENCE_OPEN_RE = /^:::([A-Za-z]+)\s*$/;

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
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

function renderColumns(bodyLines: string[]): string {
  // Split the body into column segments on a lone `+++` line.
  const segments: string[][] = [[]];
  for (const line of bodyLines) {
    if (/^\+\+\+\s*$/.test(line.trim())) segments.push([]);
    else segments[segments.length - 1]!.push(line);
  }
  const cols = segments
    .map((seg) => seg.join('\n').trim())
    .filter((s) => s.length > 0);
  // The schema requires 2+ columns; degrade a 0/1-column block to plain blocks.
  if (cols.length < 2) return renderBlocks(bodyLines.join('\n').trim());
  const inner = cols
    .map((c) => `<div data-column>${renderBlocks(c) || '<p></p>'}</div>`)
    .join('');
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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_OPEN_RE.exec(line.trim());
    if (fence) {
      flush();
      const kind = fence[1]!.toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== ':::') {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing :::
      if (kind === 'columns') out.push(renderColumns(body));
      else if ((CALLOUT_VARIANTS as readonly string[]).includes(kind))
        out.push(renderCallout(kind as CalloutVariant, body));
      else out.push(renderCallout('info', body));
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

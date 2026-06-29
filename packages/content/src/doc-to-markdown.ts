/**
 * docToMarkdown — the inverse of `markdownToDoc`. Serializes a ProseMirror /
 * TipTap page doc back into Saskia's rich-markdown dialect, so page content can
 * be exported into a note or a file (the missing direction: there was
 * `markdownToDoc` for authoring and `docToText` for the brain, but nothing that
 * round-trips a page's body back to editable markdown).
 *
 * Correctness bar: round-trip STABILITY. For any markdown `m`,
 *   markdownToDoc(docToMarkdown(markdownToDoc(m))) ≈ markdownToDoc(m)
 * (block ids regenerate, and an aside's decorative `angle` collapses to the
 * fence default — everything else is preserved). The round-trip tests assert
 * exactly that.
 *
 * Strategy:
 *  - Every node type produced by markdownToDoc has an inverse here; unknown
 *    nodes degrade to their text/children rather than throwing (mirrors the
 *    defensive stance of markdownToDoc + docToText).
 *  - Literal text is backslash-escaped for every char that could re-trigger an
 *    inline construct (`` ` `` * _ ~ = [ ] $ | < >), plus leading block markers
 *    (#, -, +, n., :::). `marked` turns `\x` back into `x`, so escaping is
 *    liberal but loss-free.
 *  - Marks wrap a text run from the inside out — code → link → colour-span →
 *    highlight → strike → italic → bold — the order that re-lexes to the same
 *    flat mark set.
 *
 * Pure + DB-free, like markdownToDoc, so it's safe to call from the tool runtime.
 */

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/* ───────────────────────────── inline ───────────────────────────── */

/** Escape every char that could re-trigger an inline construct on re-parse.
 *  Backslash first so we don't double-escape our own escapes. */
function escapeInline(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[`*_~=[\]$|<>]/g, '\\$&');
}

/** Neutralize a leading block marker so a paragraph's text doesn't re-parse as
 *  a heading / list / quote / fence. Inline escaping already handled =,*,_,~,
 *  [,<,>,|,$,`; this covers #, -, +, numbered, and the `:::` fence opener. */
function escapeLeading(text: string): string {
  return text
    .replace(/^(#{1,6})(\s|$)/, '\\$1$2')
    .replace(/^([-+]+)(\s|$)/, '\\$1$2')
    .replace(/^(\d+)([.)])(\s)/, '$1\\$2$3')
    .replace(/^(:::+)/, '\\$1');
}

/** Wrap a code span in a backtick fence long enough to contain it. */
function codeSpan(raw: string): string {
  const runs = raw.match(/`+/g);
  const n = (runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1;
  const fence = '`'.repeat(n);
  const pad = /^`|`$|^\s|\s$/.test(raw) ? ' ' : '';
  return `${fence}${pad}${raw}${pad}${fence}`;
}

/** Wrap a single text run in its marks, inside-out. */
function wrapMarks(raw: string, marks: PMMark[]): string {
  const find = (t: string) => marks.find((m) => m.type === t);

  let out = find('code') ? codeSpan(raw) : escapeInline(raw);

  const link = find('link');
  if (link) out = `[${out}](${s(link.attrs?.href)})`;

  const color = find('textColor');
  const highlight = find('highlight');
  const hlColor = s(highlight?.attrs?.color) || undefined;
  if ((color && color.attrs?.color) || hlColor) {
    const parts: string[] = [];
    if (color?.attrs?.color) parts.push(`color=${s(color.attrs.color)}`);
    if (hlColor) parts.push(`highlight=${hlColor}`);
    out = `[${out}]{${parts.join(' ')}}`;
  }
  // Plain highlight (==text==) only when it carries no colour token.
  if (highlight && !hlColor) out = `==${out}==`;

  if (find('strike')) out = `~~${out}~~`;
  if (find('italic')) out = `*${out}*`;
  if (find('bold')) out = `**${out}**`;
  return out;
}

const markSig = (marks?: PMMark[]) => JSON.stringify(marks ?? []);

/** Serialize a run of inline nodes (text + atoms) to a markdown string. */
function inlineNodes(nodes: PMNode[] | undefined): string {
  const list = nodes ?? [];
  let out = '';
  let i = 0;
  while (i < list.length) {
    const n = list[i]!;
    if (n.type === 'text') {
      // Coalesce adjacent text nodes sharing the exact mark set (markdownToDoc
      // emits one node per run, so this also keeps round-trips node-stable).
      const sig = markSig(n.marks);
      let raw = s(n.text);
      let j = i + 1;
      while (j < list.length && list[j]!.type === 'text' && markSig(list[j]!.marks) === sig) {
        raw += s(list[j]!.text);
        j++;
      }
      out += wrapMarks(raw, n.marks ?? []);
      i = j;
      continue;
    }
    switch (n.type) {
      case 'hardBreak':
        out += '\\\n';
        break;
      case 'inlineMath':
        out += `$${s(n.attrs?.latex)}$`;
        break;
      case 'image':
        out += `![${s(n.attrs?.alt).replace(/[[\]]/g, '\\$&')}](${s(n.attrs?.src)})`;
        break;
      case 'mention':
        out += escapeInline(s(n.attrs?.label ?? n.attrs?.id));
        break;
      default:
        if (n.text) out += escapeInline(s(n.text));
        else if (n.content) out += inlineNodes(n.content);
    }
    i++;
  }
  return out;
}

/* ───────────────────────────── blocks ───────────────────────────── */

/** Join a sequence of block nodes with blank lines, dropping empties. */
function blocksToMd(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map(blockToMd)
    .filter((b) => b !== '')
    .join('\n\n');
}

/** Prefix every line of `body` with `first` (line 0) / `rest` (continuations). */
function indentLines(body: string, first: string, rest: string): string {
  return body
    .split('\n')
    .map((l, i) => (i === 0 ? first + l : l ? rest + l : ''))
    .join('\n');
}

function listToMd(node: PMNode, ordered: boolean): string {
  return (node.content ?? [])
    .map((item, idx) => {
      const marker = ordered ? `${idx + 1}. ` : '- ';
      return indentLines(blocksToMd(item.content), marker, ' '.repeat(marker.length));
    })
    .join('\n');
}

function taskListToMd(node: PMNode): string {
  return (node.content ?? [])
    .map((item) => {
      const marker = item.attrs?.checked ? '- [x] ' : '- [ ] ';
      return indentLines(blocksToMd(item.content), marker, ' '.repeat(marker.length));
    })
    .join('\n');
}

/** A table cell's content flattened to a single inline string (cells are
 *  single paragraphs; `|` is already inline-escaped, breaks collapse to space). */
function cellText(cell: PMNode): string {
  return blocksToMd(cell.content)
    .replace(/\\\n/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function tableToMd(node: PMNode): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return '';
  const renderRow = (row: PMNode) =>
    `| ${(row.content ?? []).map(cellText).join(' | ')} |`;
  const header = rows[0]!;
  const cols = (header.content ?? []).length || 1;
  const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
  return [renderRow(header), sep, ...rows.slice(1).map(renderRow)].join('\n');
}

function blockToMd(node: PMNode): string {
  switch (node.type) {
    case 'paragraph':
      return escapeLeading(inlineNodes(node.content));
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${'#'.repeat(level)} ${inlineNodes(node.content)}`;
    }
    case 'horizontalRule':
      return '---';
    case 'codeBlock':
    case 'code_block': {
      const lang = s(node.attrs?.language);
      const text = (node.content ?? []).map((c) => s(c.text)).join('');
      const runs = text.match(/`+/g);
      const fence = '`'.repeat(Math.max(3, (runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1));
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'blockquote':
      return indentLines(blocksToMd(node.content), '> ', '> ')
        .split('\n')
        .map((l) => (l === '' ? '>' : l))
        .join('\n');
    case 'bulletList':
    case 'bullet_list':
      return listToMd(node, false);
    case 'orderedList':
    case 'ordered_list':
      return listToMd(node, true);
    case 'taskList':
    case 'task_list':
      return taskListToMd(node);
    case 'table':
      return tableToMd(node);
    case 'callout': {
      const variant = s(node.attrs?.variant) || 'info';
      return `:::${variant}\n${blocksToMd(node.content)}\n:::`;
    }
    case 'aside': {
      const color = s(node.attrs?.color);
      return `:::aside${color ? ` ${color}` : ''}\n${blocksToMd(node.content)}\n:::`;
    }
    case 'columnList':
    case 'column_list': {
      const cols = (node.content ?? []).map((c) => blocksToMd(c.content));
      return `:::columns\n${cols.join('\n+++\n')}\n:::`;
    }
    case 'image':
      return `![${s(node.attrs?.alt).replace(/[[\]]/g, '\\$&')}](${s(node.attrs?.src)})`;
    case 'blockMath': {
      const latex = s(node.attrs?.latex);
      return latex.includes('\n') ? `$$\n${latex}\n$$` : `$$${latex}$$`;
    }
    default:
      // Unknown / future node: keep its text content if any.
      if (node.content) return blocksToMd(node.content);
      return node.text ? escapeInline(s(node.text)) : '';
  }
}

/**
 * Serialize a ProseMirror page doc to rich-markdown. Accepts a doc object
 * (`{ type: 'doc', content: [...] }`), a bare content array, or a string
 * (returned as-is). Never throws.
 */
export function docToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!doc || typeof doc !== 'object') return '';
  const node = doc as PMNode;
  const content = Array.isArray(node.content)
    ? node.content
    : Array.isArray(doc)
      ? (doc as PMNode[])
      : [];
  return blocksToMd(content).replace(/[ \t]+$/gm, '');
}

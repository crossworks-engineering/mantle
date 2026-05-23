/**
 * markdownToDoc — the inverse of `docToText` for authoring. Converts Saskia's
 * rich-markdown dialect into a ProseMirror / TipTap JSON document so an agent
 * can CREATE and UPDATE pages (which store `pages.doc` as ProseMirror JSON, not
 * markdown). The node names/attrs here MUST match the Pages editor schema
 * (`apps/web/components/page-editor/extensions.ts`): paragraph, heading,
 * bulletList/orderedList/listItem, taskList/taskItem, codeBlock, blockquote,
 * horizontalRule, table/tableRow/tableHeader/tableCell, callout, columnList/
 * column, plus the bold/italic/strike/code/link/highlight marks.
 *
 * The dialect is GFM markdown (via `marked`) plus three container constructs
 * markdown lacks — identical to what the assistant renderer accepts and what
 * the rich_writing skill teaches:
 *
 *   Callout:  :::info … :::      (variants info|success|warning|danger)
 *   Columns:  :::columns … +++ … :::   (2+ parts split by a lone +++)
 *   Highlight: ==text==
 *
 * Pure (only `marked`) and DB-free, so it's safe to call from the tool
 * runtime. Defensive: anything it can't map degrades to a paragraph rather
 * than throwing.
 */
import { Marked, type TokenizerAndRendererExtension } from 'marked';

type PMMark = { type: string; attrs?: Record<string, unknown> };
type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

/** Loose view of the marked token shapes we read. */
type Tok = {
  type: string;
  text?: string;
  depth?: number;
  lang?: string;
  ordered?: boolean;
  task?: boolean;
  checked?: boolean;
  href?: string;
  tokens?: Tok[];
  items?: Tok[];
  header?: Array<{ tokens?: Tok[] }>;
  rows?: Array<Array<{ tokens?: Tok[] }>>;
};

const highlightExtension: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline',
  start(src) {
    return src.indexOf('==');
  },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
    if (!m) return undefined;
    return { type: 'highlight', raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
  },
};

const md = new Marked({ gfm: true });
md.use({ extensions: [highlightExtension] });

const CALLOUT_VARIANTS = new Set(['info', 'success', 'warning', 'danger']);
const FENCE_OPEN = /^:::([A-Za-z]+)\s*$/;

function lex(src: string): Tok[] {
  return md.lexer(src) as unknown as Tok[];
}

function withMark(marks: PMMark[], m: PMMark): PMMark[] {
  return [...marks, m];
}

/** Map marked inline tokens to ProseMirror text/hardBreak nodes. */
function inline(tokens: Tok[] | undefined, marks: PMMark[] = []): PMNode[] {
  const out: PMNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text':
      case 'escape':
      case 'html': {
        const text = t.text ?? '';
        if (text) out.push(marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });
        break;
      }
      case 'strong':
        out.push(...inline(t.tokens, withMark(marks, { type: 'bold' })));
        break;
      case 'em':
        out.push(...inline(t.tokens, withMark(marks, { type: 'italic' })));
        break;
      case 'del':
        out.push(...inline(t.tokens, withMark(marks, { type: 'strike' })));
        break;
      case 'highlight':
        out.push(...inline(t.tokens, withMark(marks, { type: 'highlight' })));
        break;
      case 'codespan': {
        const text = t.text ?? '';
        if (text) out.push({ type: 'text', text, marks: withMark(marks, { type: 'code' }) });
        break;
      }
      case 'link':
        out.push(...inline(t.tokens, withMark(marks, { type: 'link', attrs: { href: t.href ?? '' } })));
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      default:
        if (t.text)
          out.push(marks.length ? { type: 'text', text: t.text, marks: [...marks] } : { type: 'text', text: t.text });
    }
  }
  return out;
}

function paragraph(tokens: Tok[] | undefined, fallback?: string): PMNode {
  const content = inline(tokens);
  if (content.length === 0 && fallback) content.push({ type: 'text', text: fallback });
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** Block content must be non-empty for listItem/blockquote/cell/etc. */
function nonEmpty(b: PMNode[]): PMNode[] {
  return b.length ? b : [{ type: 'paragraph' }];
}

function listNode(t: Tok): PMNode {
  const items = t.items ?? [];
  if (items.some((it) => it.task)) {
    return {
      type: 'taskList',
      content: items.map((it) => ({
        type: 'taskItem',
        attrs: { checked: !!it.checked },
        content: nonEmpty(blocks(it.tokens)),
      })),
    };
  }
  return {
    type: t.ordered ? 'orderedList' : 'bulletList',
    content: items.map((it) => ({ type: 'listItem', content: nonEmpty(blocks(it.tokens)) })),
  };
}

function tableNode(t: Tok): PMNode {
  const headerRow: PMNode = {
    type: 'tableRow',
    content: (t.header ?? []).map((c) => ({ type: 'tableHeader', content: [paragraph(c.tokens)] })),
  };
  const bodyRows: PMNode[] = (t.rows ?? []).map((row) => ({
    type: 'tableRow',
    content: row.map((c) => ({ type: 'tableCell', content: [paragraph(c.tokens)] })),
  }));
  return { type: 'table', content: [headerRow, ...bodyRows] };
}

/** Map marked block tokens to ProseMirror block nodes. */
function blocks(tokens: Tok[] | undefined): PMNode[] {
  const out: PMNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'heading':
        out.push({
          type: 'heading',
          attrs: { level: Math.min(Math.max(t.depth ?? 1, 1), 3) },
          content: inline(t.tokens),
        });
        break;
      case 'paragraph':
        out.push(paragraph(t.tokens));
        break;
      case 'text':
        out.push(paragraph(t.tokens, t.text));
        break;
      case 'blockquote':
        out.push({ type: 'blockquote', content: nonEmpty(blocks(t.tokens)) });
        break;
      case 'code': {
        const codeText = t.text ?? '';
        out.push({
          type: 'codeBlock',
          attrs: { language: t.lang ? t.lang : null },
          ...(codeText ? { content: [{ type: 'text', text: codeText }] } : {}),
        });
        break;
      }
      case 'hr':
        out.push({ type: 'horizontalRule' });
        break;
      case 'list':
        out.push(listNode(t));
        break;
      case 'table':
        out.push(tableNode(t));
        break;
      default:
        if (t.tokens) out.push(paragraph(t.tokens));
        else if (t.text) out.push(paragraph(undefined, t.text));
    }
  }
  return out;
}

function columnsNode(body: string[]): PMNode | null {
  const segs: string[][] = [[]];
  for (const l of body) {
    if (/^\+\+\+\s*$/.test(l.trim())) segs.push([]);
    else segs[segs.length - 1]!.push(l);
  }
  const cols = segs.map((s) => s.join('\n').trim()).filter((s) => s.length > 0);
  if (cols.length < 2) return null;
  return {
    type: 'columnList',
    content: cols.map((c) => ({ type: 'column', content: nonEmpty(blocks(lex(c))) })),
  };
}

export function markdownToDoc(source: string): Record<string, unknown> {
  const lines = (source ?? '').replace(/\r\n/g, '\n').split('\n');
  const content: PMNode[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) {
      const text = plain.join('\n');
      if (text.trim()) content.push(...blocks(lex(text)));
      plain = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line.trim());
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
      if (kind === 'columns') {
        const col = columnsNode(body);
        if (col) content.push(col);
        else content.push(...blocks(lex(body.join('\n'))));
      } else {
        const variant = CALLOUT_VARIANTS.has(kind) ? kind : 'info';
        content.push({ type: 'callout', attrs: { variant }, content: nonEmpty(blocks(lex(body.join('\n')))) });
      }
      continue;
    }
    plain.push(line);
    i++;
  }
  flush();

  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

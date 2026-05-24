/**
 * Server-side ProseMirror-JSON → sanitized HTML renderer for the PUBLIC page
 * surface. The shared page schema renders client-side via TipTap in-app; for an
 * anonymous, possibly-crawled public page we render static HTML on the server
 * (no client JS, fast, safe). Output is wrapped by the caller in a
 * `.ProseMirror .prose` container so it reuses the editor CSS in globals.css.
 *
 * HTML is built from a known tag set with all text + attributes escaped, so
 * there's no pass-through user HTML to sanitize. Math is pre-rendered with
 * KaTeX, code with lowlight; image/file embeds are rewritten to the scoped
 * public asset route via `assetUrl`. This is a third representation of the page
 * schema (editor / markdownToDoc / here) — see docs/sharing.md §5.
 */
import katex from 'katex';
import { common, createLowlight } from 'lowlight';
import { toHtml } from 'hast-util-to-html';
// Relative (not `@/`) so the vitest unit test, which has no path-alias, resolves it.
import { cellBgColor } from '../components/page-editor/table-cell-bg';

const lowlight = createLowlight(common);

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
};

export type RenderOptions = {
  /** Build the public URL for an embedded file node id. */
  assetUrl: (fileId: string) => string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Inline `style="text-align:…"` for an aligned block, or '' for default/left.
 *  Restricted to a known set so there's no arbitrary style injection. */
function alignStyle(node: PMNode): string {
  const a = str(node.attrs?.textAlign);
  return a === 'center' || a === 'right' || a === 'justify' ? ` style="text-align:${a}"` : '';
}

/** Only allow safe link protocols; everything else becomes inert. */
function safeHref(href: string): string {
  const h = href.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(h)) return h;
  return '#';
}

function renderText(node: PMNode): string {
  let html = esc(node.text ?? '');
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'subscript':
        html = `<sub>${html}</sub>`;
        break;
      case 'superscript':
        html = `<sup>${html}</sup>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'highlight':
        html = `<mark>${html}</mark>`;
        break;
      case 'link':
        html = `<a href="${escAttr(safeHref(str(mark.attrs?.href)))}" target="_blank" rel="noopener nofollow ugc">${html}</a>`;
        break;
    }
  }
  return html;
}

function renderInline(nodes: PMNode[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') out += renderText(n);
    else if (n.type === 'hardBreak') out += '<br>';
    else if (n.type === 'inlineMath') out += renderMath(str(n.attrs?.latex), false);
    else if (n.type === 'mention')
      out += `<span class="mention">${esc(str(n.attrs?.label) || str(n.attrs?.id))}</span>`;
    else if (n.content) out += renderInline(n.content); // defensive
  }
  return out;
}

function renderMath(latex: string, block: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode: block, throwOnError: false });
  } catch {
    return `<code>${esc(latex)}</code>`;
  }
}

function renderCode(node: PMNode): string {
  const text = (node.content ?? []).map((c) => c.text ?? '').join('');
  const lang = str(node.attrs?.language);
  try {
    const tree = lang && lowlight.registered(lang) ? lowlight.highlight(lang, text) : lowlight.highlightAuto(text);
    const inner = toHtml(tree);
    const cls = lang ? ` class="language-${escAttr(lang)}"` : '';
    return `<pre><code${cls}>${inner}</code></pre>`;
  } catch {
    return `<pre><code>${esc(text)}</code></pre>`;
  }
}

function renderBlock(node: PMNode, opts: RenderOptions): string {
  switch (node.type) {
    case 'paragraph': {
      const inner = renderInline(node.content);
      const align = alignStyle(node);
      if (!inner) return '<p></p>';
      return `<p${align}>${inner}</p>`;
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      const align = alignStyle(node);
      return `<h${level}${align}>${renderInline(node.content)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${renderBlocks(node.content, opts)}</blockquote>`;
    case 'bulletList':
      return `<ul>${renderBlocks(node.content, opts)}</ul>`;
    case 'orderedList':
      return `<ol>${renderBlocks(node.content, opts)}</ol>`;
    case 'listItem':
      return `<li>${renderBlocks(node.content, opts)}</li>`;
    case 'taskList':
      return `<ul data-type="taskList">${renderBlocks(node.content, opts)}</ul>`;
    case 'taskItem': {
      const checked = node.attrs?.checked ? ' data-checked="true"' : ' data-checked="false"';
      const box = `<input type="checkbox" disabled${node.attrs?.checked ? ' checked' : ''}>`;
      return `<li data-type="taskItem"${checked}><label>${box}</label><div>${renderBlocks(node.content, opts)}</div></li>`;
    }
    case 'codeBlock':
      return renderCode(node);
    case 'horizontalRule':
      return '<hr>';
    case 'blockMath':
      return `<div class="math-block">${renderMath(str(node.attrs?.latex), true)}</div>`;
    case 'callout': {
      const variant = ['info', 'success', 'warning', 'danger'].includes(str(node.attrs?.variant))
        ? str(node.attrs?.variant)
        : 'info';
      return `<div data-callout data-variant="${escAttr(variant)}">${renderBlocks(node.content, opts)}</div>`;
    }
    case 'columnList':
      return `<div data-column-list class="column-list">${renderBlocks(node.content, opts)}</div>`;
    case 'column':
      return `<div data-column class="column">${renderBlocks(node.content, opts)}</div>`;
    case 'table':
      return `<div class="tableWrapper"><table><tbody>${renderBlocks(node.content, opts)}</tbody></table></div>`;
    case 'tableRow':
      return `<tr>${renderBlocks(node.content, opts)}</tr>`;
    case 'tableHeader':
    case 'tableCell': {
      const tag = node.type === 'tableHeader' ? 'th' : 'td';
      const attrs: string[] = [];
      const colspan = Number(node.attrs?.colspan);
      const rowspan = Number(node.attrs?.rowspan);
      if (colspan > 1) attrs.push(`colspan="${colspan}"`);
      if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
      const bg = cellBgColor(node.attrs?.backgroundColor);
      if (bg) attrs.push(`style="background-color:${bg}"`);
      const a = attrs.length ? ` ${attrs.join(' ')}` : '';
      return `<${tag}${a}>${renderBlocks(node.content, opts)}</${tag}>`;
    }
    case 'image': {
      const fileId = str(node.attrs?.nodeId);
      const src = fileId ? opts.assetUrl(fileId) : str(node.attrs?.src);
      const alt = escAttr(str(node.attrs?.alt));
      return src ? `<img src="${escAttr(src)}" alt="${alt}" loading="lazy">` : '';
    }
    case 'audio': {
      const fileId = str(node.attrs?.nodeId);
      const src = fileId ? opts.assetUrl(fileId) : str(node.attrs?.src);
      if (!src) return '';
      return `<audio controls src="${escAttr(src)}"></audio>`;
    }
    case 'fileEmbed': {
      const fileId = str(node.attrs?.nodeId);
      const href = fileId ? opts.assetUrl(fileId) : str(node.attrs?.href);
      const name = esc(str(node.attrs?.filename) || 'file');
      return `<a class="file-embed" href="${escAttr(href || '#')}" target="_blank" rel="noopener">${name}</a>`;
    }
    default:
      // Unknown block — render its children if any, else drop.
      return node.content ? renderBlocks(node.content, opts) : '';
  }
}

function renderBlocks(nodes: PMNode[] | undefined, opts: RenderOptions): string {
  return (nodes ?? []).map((n) => renderBlock(n, opts)).join('');
}

/** Render a ProseMirror page document to sanitized HTML. */
export function renderPageDoc(doc: unknown, opts: RenderOptions): string {
  if (!doc || typeof doc !== 'object') return '';
  const root = doc as PMNode;
  return renderBlocks(root.content, opts);
}

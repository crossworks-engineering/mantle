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
import { highlightColor } from '../components/page-editor/highlight-colors';
import { textColor } from '../components/page-editor/text-colors';
import {
  asideBackground,
  asideBorderColor,
  normalizeAsideAngle,
  normalizeAsideColor,
} from '../components/page-editor/aside-style';

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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'highlight': {
        const c = highlightColor(mark.attrs?.color);
        html = c ? `<mark style="background-color:${c}">${html}</mark>` : `<mark>${html}</mark>`;
        break;
      }
      case 'textColor': {
        const c = textColor(mark.attrs?.color);
        if (c) html = `<span style="color:${c}">${html}</span>`;
        break;
      }
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
    const tree =
      lang && lowlight.registered(lang)
        ? lowlight.highlight(lang, text)
        : lowlight.highlightAuto(text);
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
      return inner ? `<p>${inner}</p>` : '<p></p>';
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      // Emit the block id as the element id so the outline can anchor-scroll to it.
      const id = str(node.attrs?.id);
      const idAttr = id ? ` id="${escAttr(id)}"` : '';
      return `<h${level}${idAttr}>${renderInline(node.content)}</h${level}>`;
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
    case 'aside': {
      const color = normalizeAsideColor(node.attrs?.color);
      const angle = normalizeAsideAngle(node.attrs?.angle);
      const style = `background:${asideBackground(color, angle)};border-color:${asideBorderColor(color)}`;
      return `<div data-aside data-color="${escAttr(color)}" style="${escAttr(style)}">${renderBlocks(node.content, opts)}</div>`;
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
      return `<th>${renderBlocks(node.content, opts)}</th>`;
    case 'tableCell':
      return `<td>${renderBlocks(node.content, opts)}</td>`;
    case 'image': {
      const fileId = str(node.attrs?.nodeId);
      const src = fileId ? opts.assetUrl(fileId) : str(node.attrs?.src);
      const alt = escAttr(str(node.attrs?.alt));
      return src ? `<img src="${escAttr(src)}" alt="${alt}" loading="lazy">` : '';
    }
    case 'fileEmbed': {
      const fileId = str(node.attrs?.nodeId);
      const href = fileId ? opts.assetUrl(fileId) : str(node.attrs?.href);
      const name = esc(str(node.attrs?.filename) || 'file');
      return `<a class="file-embed" href="${escAttr(href || '#')}" target="_blank" rel="noopener">${name}</a>`;
    }
    case 'childPage': {
      // Sub-pages aren't part of a shared subtree (Phase 4a) — render the card
      // as an inert label, not a link into a private child page. The block id
      // is emitted so the outline can anchor-scroll to it.
      const title = esc(str(node.attrs?.title) || 'Untitled page');
      const icon = str(node.attrs?.icon);
      const id = str(node.attrs?.id);
      const idAttr = id ? ` id="${escAttr(id)}"` : '';
      const iconHtml = icon ? `<span class="child-page-icon">${esc(icon)}</span>` : '';
      return `<div class="child-page" data-child-page${idAttr}>${iconHtml}<span class="child-page-title">${title}</span></div>`;
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

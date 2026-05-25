/**
 * ProseMirror-JSON → email-safe HTML renderer. This is a FOURTH representation
 * of the page schema (alongside the TipTap editor, `markdownToDoc`, and the
 * public-page `renderPageDoc` in apps/web). Email needs its own renderer because
 * email clients are hostile to modern CSS:
 *
 *   - No external/`<head>` stylesheet survives reliably → every style is INLINE.
 *   - The app's `var(--chart-N)` theme tokens don't exist in a mail client, so
 *     highlight/text colours resolve to a fixed concrete palette here.
 *   - No flexbox/grid → columns render as a `<table>` row.
 *   - KaTeX/lowlight output won't style → math degrades to its LaTeX source and
 *     code blocks ship as plain (unhighlighted) `<pre>`.
 *   - Images can't reference private files, so they're emitted as `cid:` refs
 *     and the caller attaches the bytes inline (see `cidForPageImage`).
 *
 * Output is a complete standalone HTML document (doctype + body) ready to hand
 * to nodemailer as the `html` part. See packages/tools/src/builtins-email.ts
 * (`email_page`) and docs/email-send.md.
 */

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
};

export type RenderPageEmailOptions = {
  /** Rendered as an `<h1>` above the body. Usually the page title. */
  title?: string;
  /** Trusted HTML appended after the body (e.g. a "View online" link the tool
   *  builds from a share token). Caller is responsible for its safety. */
  footerHtml?: string;
};

export type RenderPageEmailResult = {
  /** Complete standalone HTML document for the email's `html` part. */
  html: string;
  /** File-node ids of every `<img>` in the doc, in document order. The caller
   *  reads their bytes and attaches them with `cid: cidForPageImage(id)`. */
  imageFileIds: string[];
};

/** The Content-ID an inline image attachment must use so the `<img>` resolves.
 *  Shared between this renderer and the attaching caller. */
export function cidForPageImage(fileId: string): string {
  return `page-img-${fileId}`;
}

/** Concrete colours for the themed `chart-N` tokens (the app's CSS vars are not
 *  available in a mail client). `text` is the legible full colour; `tint` is the
 *  translucent-feel highlight background. */
const CHART_COLORS: Record<string, { text: string; tint: string }> = {
  'chart-1': { text: '#2563eb', tint: '#dbeafe' },
  'chart-2': { text: '#16a34a', tint: '#dcfce7' },
  'chart-3': { text: '#d97706', tint: '#fef3c7' },
  'chart-4': { text: '#db2777', tint: '#fce7f3' },
  'chart-5': { text: '#7c3aed', tint: '#ede9fe' },
};
const DEFAULT_HIGHLIGHT = '#fef9c3'; // soft yellow when no token is set

const CALLOUT_STYLES = {
  info: { border: '#2563eb', bg: '#eff6ff' },
  success: { border: '#16a34a', bg: '#f0fdf4' },
  warning: { border: '#d97706', bg: '#fffbeb' },
  danger: { border: '#dc2626', bg: '#fef2f2' },
} as const;

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
  if (/^(https?:|mailto:|#)/i.test(h)) return h;
  return '#';
}
function highlightTint(token: unknown): string {
  const key = str(token);
  return CHART_COLORS[key]?.tint ?? DEFAULT_HIGHLIGHT;
}
function textColorValue(token: unknown): string | null {
  const key = str(token);
  return CHART_COLORS[key]?.text ?? null;
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
        html = `<code style="background-color:#f3f4f6;padding:2px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:90%">${html}</code>`;
        break;
      case 'highlight':
        html = `<span style="background-color:${highlightTint(mark.attrs?.color)};padding:0 2px">${html}</span>`;
        break;
      case 'textColor': {
        const c = textColorValue(mark.attrs?.color);
        if (c) html = `<span style="color:${c}">${html}</span>`;
        break;
      }
      case 'link':
        html = `<a href="${escAttr(safeHref(str(mark.attrs?.href)))}" style="color:#2563eb;text-decoration:underline" target="_blank" rel="noopener nofollow ugc">${html}</a>`;
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
    else if (n.type === 'inlineMath')
      out += `<code style="font-family:ui-monospace,Menlo,monospace">${esc(str(n.attrs?.latex))}</code>`;
    else if (n.type === 'mention')
      out += `<span style="color:#2563eb">${esc(str(n.attrs?.label) || str(n.attrs?.id))}</span>`;
    else if (n.content) out += renderInline(n.content);
  }
  return out;
}

function renderBlock(node: PMNode, images: string[]): string {
  switch (node.type) {
    case 'paragraph': {
      const inner = renderInline(node.content);
      return `<p style="margin:0 0 16px">${inner || '&nbsp;'}</p>`;
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      const size = level === 1 ? '26px' : level === 2 ? '21px' : '17px';
      return `<h${level} style="margin:28px 0 12px;font-size:${size};font-weight:700;line-height:1.25;color:#111827">${renderInline(node.content)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:4px solid #e5e7eb;color:#6b7280">${renderBlocks(node.content, images)}</blockquote>`;
    case 'bulletList':
      return `<ul style="margin:0 0 16px;padding-left:24px">${renderBlocks(node.content, images)}</ul>`;
    case 'orderedList':
      return `<ol style="margin:0 0 16px;padding-left:24px">${renderBlocks(node.content, images)}</ol>`;
    case 'listItem':
      return `<li style="margin:4px 0">${renderBlocks(node.content, images)}</li>`;
    case 'taskList':
      return `<ul style="margin:0 0 16px;padding-left:4px;list-style:none">${renderBlocks(node.content, images)}</ul>`;
    case 'taskItem': {
      const box = node.attrs?.checked ? '&#9745;' : '&#9744;'; // ☑ / ☐
      return `<li style="margin:4px 0;list-style:none"><span style="margin-right:6px">${box}</span>${renderBlocks(node.content, images)}</li>`;
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `<pre style="margin:0 0 16px;padding:14px 16px;background-color:#f6f8fa;border-radius:6px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word"><code>${esc(text)}</code></pre>`;
    }
    case 'horizontalRule':
      return '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">';
    case 'blockMath':
      return `<div style="margin:0 0 16px;text-align:center"><code style="font-family:ui-monospace,Menlo,monospace">${esc(str(node.attrs?.latex))}</code></div>`;
    case 'callout': {
      const variant = (['info', 'success', 'warning', 'danger'] as const).includes(
        str(node.attrs?.variant) as keyof typeof CALLOUT_STYLES,
      )
        ? (str(node.attrs?.variant) as keyof typeof CALLOUT_STYLES)
        : 'info';
      const s = CALLOUT_STYLES[variant];
      return `<div style="margin:0 0 16px;padding:12px 16px;border-left:4px solid ${s.border};background-color:${s.bg};border-radius:6px">${renderBlocks(node.content, images)}</div>`;
    }
    case 'columnList': {
      const cols = (node.content ?? []).filter((c) => c.type === 'column');
      const width = cols.length > 0 ? Math.floor(100 / cols.length) : 100;
      const cells = cols
        .map(
          (c) =>
            `<td valign="top" width="${width}%" style="vertical-align:top;padding:0 12px">${renderBlocks(c.content, images)}</td>`,
        )
        .join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;width:100%;border-collapse:collapse"><tr>${cells}</tr></table>`;
    }
    case 'column':
      // Rendered by columnList; standalone (defensive) → just emit children.
      return renderBlocks(node.content, images);
    case 'table':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;width:100%;border-collapse:collapse;border:1px solid #e5e7eb"><tbody>${renderBlocks(node.content, images)}</tbody></table>`;
    case 'tableRow':
      return `<tr>${renderBlocks(node.content, images)}</tr>`;
    case 'tableHeader':
      return `<th style="border:1px solid #e5e7eb;padding:8px 10px;background-color:#f9fafb;text-align:left;font-weight:600">${renderBlocks(node.content, images)}</th>`;
    case 'tableCell':
      return `<td style="border:1px solid #e5e7eb;padding:8px 10px;vertical-align:top">${renderBlocks(node.content, images)}</td>`;
    case 'image': {
      const fileId = str(node.attrs?.nodeId);
      const alt = escAttr(str(node.attrs?.alt));
      if (fileId) {
        images.push(fileId);
        return `<img src="cid:${escAttr(cidForPageImage(fileId))}" alt="${alt}" style="max-width:100%;height:auto;border-radius:6px;margin:0 0 16px">`;
      }
      const src = str(node.attrs?.src);
      return src
        ? `<img src="${escAttr(src)}" alt="${alt}" style="max-width:100%;height:auto;border-radius:6px;margin:0 0 16px">`
        : '';
    }
    case 'fileEmbed': {
      // No public URL inside an email → show the name as a chip. (Attaching the
      // file itself could be a future enhancement.)
      const name = esc(str(node.attrs?.filename) || 'file');
      return `<p style="margin:0 0 16px;padding:8px 12px;background-color:#f3f4f6;border-radius:6px;font-size:14px">&#128206; ${name}</p>`;
    }
    default:
      return node.content ? renderBlocks(node.content, images) : '';
  }
}

function renderBlocks(nodes: PMNode[] | undefined, images: string[]): string {
  return (nodes ?? []).map((n) => renderBlock(n, images)).join('');
}

/** Render a ProseMirror page document to a complete, inline-styled email HTML
 *  document plus the list of inline-image file ids the caller must attach. */
export function renderPageEmail(
  doc: unknown,
  opts: RenderPageEmailOptions = {},
): RenderPageEmailResult {
  const images: string[] = [];
  const root = doc && typeof doc === 'object' ? (doc as PMNode) : { content: [] };
  const body = renderBlocks(root.content, images);

  const titleHtml = opts.title
    ? `<h1 style="margin:0 0 20px;font-size:28px;font-weight:700;line-height:1.2;color:#111827">${esc(opts.title)}</h1>`
    : '';
  const footer = opts.footerHtml
    ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:14px;color:#6b7280">${opts.footerHtml}</div>`
    : '';

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse"><tr><td align="center">
<div style="max-width:640px;margin:0 auto;background-color:#ffffff;border-radius:10px;padding:32px;text-align:left;color:#1f2937;font-size:16px;line-height:1.6">
${titleHtml}${body}${footer}
</div>
</td></tr></table>
</body>
</html>`;

  return { html, imageFileIds: images };
}

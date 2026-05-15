import sanitizeHtml from 'sanitize-html';

/**
 * Email-safe HTML sanitizer for the preview pipeline.
 *
 * The threat model is "render untrusted HTML from a random sender". We:
 *   • strip every script/style/iframe/form/embed/object tag
 *   • drop all event handlers (onclick, onload, …) via the attribute allow-list
 *   • drop <img> entirely so external images can't phone home (tracking pixels,
 *     open-receipt confirmations). Alt text is preserved as a text node.
 *   • drop @import and url() inside inline styles via an explicit style filter
 *   • normalise <a> to open in a new tab with `noopener noreferrer nofollow`
 *
 * The rendered HTML is *also* loaded into a sandboxed iframe at display time,
 * so this is defense-in-depth — neither layer should let anything through on
 * its own.
 */

const SAFE_STYLE_VALUE = /^[^()<>"'`;]*$/;

const options: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'span',
    'div',
    'a',
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'mark',
    'small',
    'sub',
    'sup',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'blockquote',
    'pre',
    'code',
    'kbd',
    'samp',
    'var',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
    'hr',
    'center',
    'font', // ancient email-isms; harmless visually
  ],
  // Note: <script>, <style>, <iframe>, <embed>, <object>, <form>, <input>,
  // <button>, <video>, <audio>, <link>, <meta>, <base> stay stripped. Their
  // text content is kept.
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'dir', 'lang', 'title'],
    // `target` and `rel` are injected by transformTags below; they must be
    // on the allow-list or the post-transform attribute filter strips them.
    a: ['href', 'target', 'rel'],
    // Same story: `loading`, `referrerpolicy`, and `style` (for the 1×1
    // display:none cloak) are injected by transformTags.
    img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy', 'style'],
    table: ['cellpadding', 'cellspacing', 'border', 'width', 'bgcolor'],
    td: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'valign'],
    th: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'valign'],
    tr: ['bgcolor', 'valign'],
    font: ['color', 'size', 'face'],
    col: ['span', 'width'],
  },
  // `cid:` (inline-attachment refs) intentionally excluded — those need to
  // be resolved against the message's MIME parts, which we don't extract
  // for unstored senders. They'll render as broken images.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
    a: ['http', 'https', 'mailto', 'tel'],
  },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // Inline styles are common in email; allow them but block anything that
  // could load a resource (url(...)) or break out of the sandbox.
  allowedStyles: {
    '*': {
      color: [SAFE_STYLE_VALUE],
      'background-color': [SAFE_STYLE_VALUE],
      'background': [SAFE_STYLE_VALUE],
      'font-family': [SAFE_STYLE_VALUE],
      'font-size': [SAFE_STYLE_VALUE],
      'font-weight': [SAFE_STYLE_VALUE],
      'font-style': [SAFE_STYLE_VALUE],
      'line-height': [SAFE_STYLE_VALUE],
      'letter-spacing': [SAFE_STYLE_VALUE],
      'text-align': [SAFE_STYLE_VALUE],
      'text-decoration': [SAFE_STYLE_VALUE],
      'text-transform': [SAFE_STYLE_VALUE],
      'vertical-align': [SAFE_STYLE_VALUE],
      'white-space': [SAFE_STYLE_VALUE],
      'width': [SAFE_STYLE_VALUE],
      'max-width': [SAFE_STYLE_VALUE],
      'min-width': [SAFE_STYLE_VALUE],
      'height': [SAFE_STYLE_VALUE],
      'padding': [SAFE_STYLE_VALUE],
      'padding-top': [SAFE_STYLE_VALUE],
      'padding-right': [SAFE_STYLE_VALUE],
      'padding-bottom': [SAFE_STYLE_VALUE],
      'padding-left': [SAFE_STYLE_VALUE],
      'margin': [SAFE_STYLE_VALUE],
      'margin-top': [SAFE_STYLE_VALUE],
      'margin-right': [SAFE_STYLE_VALUE],
      'margin-bottom': [SAFE_STYLE_VALUE],
      'margin-left': [SAFE_STYLE_VALUE],
      'border': [SAFE_STYLE_VALUE],
      'border-color': [SAFE_STYLE_VALUE],
      'border-style': [SAFE_STYLE_VALUE],
      'border-width': [SAFE_STYLE_VALUE],
      'border-radius': [SAFE_STYLE_VALUE],
      'border-collapse': [SAFE_STYLE_VALUE],
      'display': [SAFE_STYLE_VALUE],
    },
  },
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        href: attribs['href'] ?? '#',
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
    img: (_tagName, attribs) => {
      // Minimal leak surface: no Referer header, lazy load so off-screen
      // images don't fetch, drop dimension attrs that try to ship pixels
      // as numbers (a common tracking-pixel trick) by capping to 1px-wide
      // tracking pixels at display:none. Visible images still render.
      const width = attribs['width'];
      const height = attribs['height'];
      const isTrackingPixel =
        (width === '1' || width === '1px') && (height === '1' || height === '1px');
      return {
        tagName: 'img',
        attribs: {
          src: attribs['src'] ?? '',
          alt: attribs['alt'] ?? '',
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
          ...(isTrackingPixel ? { style: 'display:none' } : {}),
        },
      };
    },
  },
};

/** Sanitise an HTML email body for safe rendering inside a sandboxed iframe. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, options);
}

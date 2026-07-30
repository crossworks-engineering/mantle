/**
 * Word (.docx) text + embedded-image extraction. Thin wrapper around
 * `mammoth`.
 *
 * `parseDocx` returns the document's raw text (paragraphs joined by
 * newlines). Layout, styling, and tables are flattened — this is for the
 * brain's "what does this document say" recall, not faithful reproduction.
 *
 * `extractDocxImages` returns the pictures that text pass throws away, in
 * reading order and carrying the surrounding context that names them.
 *
 * Only the modern OOXML `.docx` format is supported. Legacy binary
 * `.doc` is a different (pre-2007) format mammoth can't read — those
 * fall through to the title in the extractor, same as a scanned PDF.
 *
 * Separate entry point (`@mantle/files/docx`) so mammoth is only loaded
 * when a Word doc actually shows up.
 */

import mammoth from 'mammoth';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';

export async function parseDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return (result.value ?? '').trim();
}

// ─── embedded images ──────────────────────────────────────────────────

/** The subset of mammoth's document AST we care about. Mammoth exposes no
 *  types for it, and we only ever read, so a structural shape beats pulling
 *  in a dependency's internals. */
type MammothNode = {
  type?: string;
  styleId?: string | null;
  styleName?: string | null;
  value?: string;
  altText?: string | null;
  contentType?: string | null;
  children?: MammothNode[];
  readAsBuffer?: () => Promise<Buffer>;
  read?: (encoding?: string) => Promise<Buffer>;
};

type FlatItem =
  | { kind: 'paragraph'; style: string; text: string }
  | { kind: 'image'; node: MammothNode };

/** Word style for a heading is either the id ("Heading2") or the human name
 *  ("heading 2"), depending on how the document was authored — check both.
 *  "Title" counts: in a short manual it is the only heading there is. */
function isHeadingStyle(style: string): boolean {
  const s = style.toLowerCase().replace(/\s+/g, '');
  return /^heading\d/.test(s) || s === 'title' || s === 'subtitle';
}

/** Word's own caption style, or the convention authors use when they don't
 *  apply it ("Figure 4: …", "Fig. 2 — …", "Screenshot 1"). */
function isCaptionLike(style: string, text: string): boolean {
  if (style.toLowerCase().replace(/\s+/g, '') === 'caption') return true;
  return /^\s*(figure|fig\.?|table|image|screenshot|exhibit|diagram)\s*\d+\s*[:.\-–—]/i.test(text);
}

function textOf(node: MammothNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** Flatten the AST to an ordered stream of paragraphs and images. A
 *  paragraph emits its own marker *before* its children are walked, so an
 *  image sitting inside a paragraph lands after it — which is what makes
 *  "nearest preceding heading" and "next caption" resolvable by a single
 *  forward pass. */
function flatten(node: MammothNode, out: FlatItem[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'image') {
    out.push({ kind: 'image', node });
    return;
  }
  if (node.type === 'paragraph') {
    out.push({
      kind: 'paragraph',
      style: node.styleId ?? node.styleName ?? '',
      text: textOf(node).trim(),
    });
  }
  for (const child of node.children ?? []) flatten(child, out);
}

/** The caption for an image is the next paragraph, but only when it reads
 *  like one — otherwise the following body sentence would be mistaken for a
 *  caption on every image in the document. */
function captionAfter(items: FlatItem[], from: number): string | undefined {
  for (let i = from + 1; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'image') return undefined; // back-to-back images
    if (item.text.length === 0) continue; // blank spacer paragraph
    return isCaptionLike(item.style, item.text) ? item.text : undefined;
  }
  return undefined;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
  'image/emf': 'emf',
  'image/wmf': 'wmf',
};

/**
 * Every picture in the document, in reading order, each carrying the
 * context that can name it: the author's alt text, the caption paragraph
 * beneath it, and the heading it sits under.
 *
 * Uses mammoth's parsed document rather than reading `word/media/` out of
 * the zip, because the media folder has no order and no context — see the
 * ordering note in `embedded-images.ts`.
 *
 * Driven through `convertToHtml` specifically: it is the only entry point
 * that honours `transformDocument` (`extractRawText` silently ignores the
 * option — verified against mammoth 1.12.0, and the reason this function
 * doesn't use the cheaper-looking call). The HTML it returns is discarded;
 * the image converter is stubbed to keep mammoth from base64-inlining every
 * picture into a string we would only throw away.
 */
export async function extractDocxImages(buf: Buffer): Promise<EmbeddedImage[]> {
  const items: FlatItem[] = [];
  await mammoth.convertToHtml(
    { buffer: buf },
    {
      // Read-only visit: mammoth requires the document back unchanged.
      transformDocument: (doc: MammothNode) => {
        flatten(doc, items);
        return doc;
      },
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
    } as Parameters<typeof mammoth.convertToHtml>[1],
  );

  // First pass: pair each image with its surrounding context. Bytes are
  // read afterwards — `transformDocument` is synchronous, and mammoth keeps
  // the archive open behind the element handles.
  const pending: Array<{ node: MammothNode; heading?: string; caption?: string }> = [];
  let heading: string | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'paragraph') {
      if (isHeadingStyle(item.style) && item.text.length > 0) heading = item.text;
      continue;
    }
    pending.push({ node: item.node, heading, caption: captionAfter(items, i) });
  }

  const out: EmbeddedImage[] = [];
  for (const { node, heading: h, caption } of pending) {
    const read = node.readAsBuffer ?? node.read;
    if (!read) continue;
    const bytes = Buffer.from(await read.call(node));
    if (bytes.length === 0) continue;
    const fallbackExt = EXT_BY_CONTENT_TYPE[(node.contentType ?? '').toLowerCase()] ?? 'bin';
    const described = describeImageBytes(bytes, fallbackExt);
    out.push({
      bytes,
      ordinal: out.length + 1,
      altText: node.altText?.trim() || undefined,
      caption,
      heading: h,
      ...described,
    });
  }
  return out;
}

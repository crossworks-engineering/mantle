/**
 * Visio (.vsdx) shape text, page by page, read in-process.
 *
 * A `.vsdx` is an OPC zip of XML parts. `visio/pages/pages.xml` lists the
 * pages in the order Visio shows them, each with its name and a relationship
 * id that `pages.xml.rels` resolves to the page part. Each page part holds
 * its shapes, and a shape's label is its `<Text>` element: text runs with
 * empty formatting markers (`<cp/>`, `<pp/>`, `<tp/>`) between them. We keep
 * every `<Text>` as one line, in source order, under a `## <page name>`
 * heading. Masters (stencil shapes) are not read: their text is the stencil's
 * placeholder, not the drawing's content.
 *
 * Tika used to read these. The legacy binary `.vsd` still needs Tika (see
 * TIKA_EXTS); this file is only the zip format.
 *
 * Throws on a container JSZip cannot open, like ./pptx.ts. A drawing with no
 * shape text returns `''`, the honest no-text skip.
 *
 * A `.vsdx` is untrusted zip: a page part can claim (or, lying, hold) far
 * more than any drawing. Each part's size is checked from the zip directory
 * before it is inflated, against a per-part and a total budget, and the
 * read runs in a worker thread with a heap limit (./isolate.ts) for a part
 * whose directory lies about its size.
 */

import { SaxesParser } from 'saxes';
import { DocumentLimitError } from './document-limit';
import type { EmbeddedImage } from './embedded-images';
import { loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';

/** Bytes one page part may inflate to. A real page with thousands of shapes
 *  is a few MB of XML. */
export const MAX_VSDX_PART_BYTES = 64 * 1024 * 1024;
/** Bytes all the parts read from one drawing may inflate to together. */
export const MAX_VSDX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Bytes one embedded picture may be. */
const MAX_VSDX_IMAGE_BYTES = 32 * 1024 * 1024;

/** The entry's uncompressed size from the zip directory, without inflating
 *  (JSZip's internal `_data`, as ./sheet-read.ts and ./dwf.ts read it);
 *  `null` when the field is missing. */
function declaredSize(zip: Zip, path: string): number | null {
  const entry = zip.file(path);
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } } | null)?._data
    ?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : null;
}

/** Reads parts of one drawing against the budgets above; a part past either
 *  throws a {@link DocumentLimitError} before it is inflated. */
function partReader(zip: Zip) {
  let total = 0;
  return async (path: string): Promise<string> => {
    const entry = zip.file(path);
    if (!entry) return '';
    const size = declaredSize(zip, path) ?? 0;
    if (size > MAX_VSDX_PART_BYTES) {
      throw new DocumentLimitError(
        'too_large',
        `The drawing's part ${path} unpacks to ${Math.round(size / 1e6)} MB, past the ${MAX_VSDX_PART_BYTES / 1024 / 1024} MB a Visio page may use.`,
      );
    }
    total += size;
    if (total > MAX_VSDX_TOTAL_BYTES) {
      throw new DocumentLimitError(
        'too_large',
        `The drawing unpacks to more than ${MAX_VSDX_TOTAL_BYTES / 1024 / 1024} MB of pages.`,
      );
    }
    return entry.async('string');
  };
}

const PAGES_PART = 'visio/pages/pages.xml';

/** A Visio attribute, single- or double-quoted (Visio writes single quotes). */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}=(?:'([^']*)'|"([^"]*)")`).exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

type VisioPage = { name: string; path: string };

/** Pages in Visio's order. Without a readable `pages.xml`, every page part
 *  in numeric order (`page2.xml` before `page10.xml`), named by position. */
async function pagesInOrder(
  zip: Zip,
  read: (path: string) => Promise<string>,
): Promise<VisioPage[]> {
  const xml = await read(PAGES_PART);
  if (xml) {
    const rels = await relationshipsFor(zip, PAGES_PART);
    const pages: VisioPage[] = [];
    for (const m of xml.matchAll(/<Page\b([^>]*)>([\s\S]*?)<\/Page>/g)) {
      const rel = /<Rel\b[^>]*>/.exec(m[2] ?? '')?.[0];
      const path = rel ? rels.get(attr(rel, 'r:id') ?? '') : undefined;
      if (!path || !zip.file(path)) continue;
      const head = m[1] ?? '';
      pages.push({ name: attr(head, 'Name') ?? attr(head, 'NameU') ?? '', path });
    }
    if (pages.length > 0) return pages.map((p, i) => ({ ...p, name: p.name || `Page ${i + 1}` }));
  }
  return Object.keys(zip.files)
    .filter((p) => /^visio\/pages\/page\d+\.xml$/.test(p))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b))
    .map((path, i) => ({ name: `Page ${i + 1}`, path }));
}

/** Every `<Text>` element's text in one page part, in source order. */
export function shapeTextsOf(xml: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let text = '';
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    if (node.name === 'Text') {
      if (depth === 0) text = '';
      depth++;
    }
  });
  parser.on('text', (t) => {
    if (depth > 0) text += t;
  });
  parser.on('closetag', (node) => {
    if (node.name === 'Text' && depth > 0) {
      depth--;
      if (depth === 0) {
        const line = text.replace(/\s+/g, ' ').trim();
        if (line) out.push(line);
      }
    }
  });
  parser.write(xml).close();
  return out;
}

/** The drawing's shape text, read in a worker thread (./isolate.ts). */
export async function parseVsdx(bytes: Buffer): Promise<string> {
  const { runIsolated } = await import('./isolate');
  return runIsolated('vsdx', [bytes]);
}

/** {@link parseVsdx} on the calling thread: the parse worker's job. */
export async function parseVsdxInProcess(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const read = partReader(zip);
  const sections: string[] = [];
  for (const page of await pagesInOrder(zip, read)) {
    const xml = await read(page.path);
    let lines: string[];
    try {
      lines = shapeTextsOf(xml);
    } catch {
      // One malformed page loses its own text, not the drawing's.
      continue;
    }
    if (lines.length > 0) sections.push(`## ${page.name}\n\n${lines.join('\n')}`);
  }
  return sections.join('\n\n').trim();
}

/** The number in a media part's name (`image12.png` is 12). */
function mediaNumber(path: string): number {
  return Number(/(\d+)\.\w+$/.exec(path)?.[1] ?? 0);
}

/**
 * Pictures placed in the drawing (`visio/media/*`), in their numeric order,
 * each checked for size before it is inflated. Visio numbers media parts as
 * they are added, which is close to page order for a drawing built page by
 * page; the parts carry no position Visio's own order could be read from
 * without laying out every page. Run in the parse worker.
 */
export async function vsdxImagesInProcess(bytes: Buffer): Promise<EmbeddedImage[]> {
  const zip = await loadZip(bytes);
  const { describeImageBytes } = await import('./embedded-images');
  const paths = Object.keys(zip.files)
    .filter((p) => /^visio\/media\/[^/]+\.\w+$/i.test(p))
    .sort((a, b) => mediaNumber(a) - mediaNumber(b) || a.localeCompare(b));
  const out: EmbeddedImage[] = [];
  let total = 0;
  for (const path of paths) {
    const size = declaredSize(zip, path) ?? 0;
    if (size > MAX_VSDX_IMAGE_BYTES) continue;
    total += size;
    if (total > MAX_VSDX_TOTAL_BYTES) break;
    const data = Buffer.from((await zip.file(path)?.async('uint8array')) ?? new Uint8Array());
    if (data.length === 0) continue;
    out.push({
      bytes: data,
      ordinal: out.length + 1,
      ...describeImageBytes(data, path.slice(path.lastIndexOf('.') + 1)),
    });
  }
  return out;
}

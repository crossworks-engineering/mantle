/**
 * Visio (.vsdx) shape text and pictures, page by page. Runs in the parser
 * service (server/parser) only.
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
 * Tika used to read these. The legacy binary `.vsd` has no reader now that
 * Tika is gone: it is indexed by its name only (docs/file-ingestion.md);
 * this file is only the zip format.
 *
 * Throws on a container JSZip cannot open, like ./pptx.ts. A drawing with no
 * shape text returns `''`, the honest no-text skip.
 *
 * A `.vsdx` is untrusted zip: a page part can claim (or, lying, hold) far
 * more than any drawing. Each part's size is checked from the zip directory
 * before it is inflated, against a per-part and a total budget, and a part
 * whose directory lies is stopped by the inflate cap (./zip-guard.ts).
 */

import { SaxesParser } from 'saxes';
import { DocumentTooLargeError } from './read-limit';
import type { EmbeddedImage } from './embedded-images';
import { loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';

/** Bytes one page part may inflate to. A real page with thousands of shapes
 *  is a few MB of XML. */
export const MAX_VSDX_PART_BYTES = 64 * 1024 * 1024;
/** Bytes all the parts read from one drawing may inflate to together. */
export const MAX_VSDX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Bytes one embedded picture may be. */
const MAX_VSDX_IMAGE_BYTES = 32 * 1024 * 1024;

/** The entry's uncompressed size from the zip directory, without inflating;
 *  `null` when the field is missing. It can lie: the read itself is capped
 *  too (./zip-guard.ts). */
function declaredSize(zip: Zip, path: string): number | null {
  return zip.file(path)?.declaredSize ?? null;
}

/** Reads parts of one drawing against the budgets above; a part past either
 *  throws a {@link DocumentTooLargeError} before it is inflated. */
function partReader(zip: Zip) {
  let total = 0;
  return async (path: string): Promise<string> => {
    const entry = zip.file(path);
    if (!entry) return '';
    const size = declaredSize(zip, path) ?? 0;
    if (size > MAX_VSDX_PART_BYTES) {
      throw new DocumentTooLargeError(
        `The drawing's part ${path} unpacks to ${Math.round(size / 1e6)} MB, past the ${MAX_VSDX_PART_BYTES / 1024 / 1024} MB a Visio page may use.`,
      );
    }
    total += size;
    if (total > MAX_VSDX_TOTAL_BYTES) {
      throw new DocumentTooLargeError(
        `The drawing unpacks to more than ${MAX_VSDX_TOTAL_BYTES / 1024 / 1024} MB of pages.`,
      );
    }
    return entry.async('string');
  };
}

const PAGES_PART = 'visio/pages/pages.xml';

type VisioPage = { name: string; path: string };

/**
 * Each `<Page>` of `pages.xml` with its name and the relationship id of its
 * first `<Rel>`, in order, read with a streaming XML parser (linear; the
 * pattern this replaced rescanned to the end of the part for every `<Page>`
 * left open, 1.9 s over 256 KB). A malformed part keeps the pages read
 * before the fault.
 */
export function pageEntriesOf(xml: string): Array<{ name: string; rId: string }> {
  const out: Array<{ name: string; rId: string }> = [];
  let page: { name: string; rId: string } | null = null;
  const parser = new SaxesParser();
  parser.on('opentag', (node) => {
    if (node.name === 'Page') {
      const a = node.attributes as Record<string, string>;
      page = { name: a.Name ?? a.NameU ?? '', rId: '' };
    } else if (node.name === 'Rel' && page && !page.rId) {
      page.rId = (node.attributes as Record<string, string>)['r:id'] ?? '';
    }
  });
  parser.on('closetag', (node) => {
    if (node.name === 'Page' && page) {
      out.push(page);
      page = null;
    }
  });
  try {
    parser.write(xml).close();
  } catch {
    // Keep the pages read before the fault.
  }
  return out;
}

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
    for (const entry of pageEntriesOf(xml)) {
      const path = entry.rId ? rels.get(entry.rId) : undefined;
      if (!path || !zip.file(path)) continue;
      pages.push({ name: entry.name, path });
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

/** The drawing's shape text, page by page. */
export async function parseVsdx(bytes: Buffer): Promise<string> {
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
 * without laying out every page.
 */
export async function vsdxImages(bytes: Buffer): Promise<EmbeddedImage[]> {
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

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
 */

import { SaxesParser } from 'saxes';
import { loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';

const PAGES_PART = 'visio/pages/pages.xml';

/** A Visio attribute, single- or double-quoted (Visio writes single quotes). */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}=(?:'([^']*)'|"([^"]*)")`).exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

type VisioPage = { name: string; path: string };

/** Pages in Visio's order. Without a readable `pages.xml`, every page part
 *  in numeric order (`page2.xml` before `page10.xml`), named by position. */
async function pagesInOrder(zip: Zip): Promise<VisioPage[]> {
  const xml = await zip.file(PAGES_PART)?.async('string');
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

export async function parseVsdx(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const sections: string[] = [];
  for (const page of await pagesInOrder(zip)) {
    const xml = (await zip.file(page.path)?.async('string')) ?? '';
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

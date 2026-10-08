/**
 * PowerPoint (.pptx) text, in slide order, read in-process.
 *
 * Decks used to go to Tika. Tika 4 reads a deck with its streaming extractor
 * only (3.x's `useSAXPptxExtractor: false` is gone), and that extractor walks
 * slides in relationship-id STRING order: `rId10` sorts before `rId7`, so any
 * deck with more than a handful of slides comes back with its slides shuffled
 * (verified on 4.0.0, 4.1.0 and the 4.2.0 snapshot). Every word is still
 * there, but summaries and chunk order follow the shuffled text. Order is the
 * point of a deck, so we take this one format in-process, like `.docx`, and
 * keep Tika as the fallback for a deck this reader cannot open.
 *
 * Slide order is the presentation's own `sldIdLst`, resolved through
 * `ppt/_rels/presentation.xml.rels`, which is the order PowerPoint shows. Per
 * slide: each `<a:p>` paragraph on its own line (shapes and groups in source
 * order, a table row as one tab-joined line), then one line per chart (its
 * cached series names, categories and values, as Tika gives them), then
 * SmartArt text, then the speaker notes. Field runs (`<a:fld>`: slide
 * number, date) are dropped; they are furniture, not content.
 *
 * Same bounded regex reading as `./ooxml-media.ts`, for the same reasons: the
 * input is machine-written OOXML and we only collect text runs in source
 * order. Throws on a container JSZip cannot open; `parseDocumentBytes` turns
 * that, and an empty result, into the Tika fallback.
 */

import { ATTR, loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';

const NOTES_REL = /\/relationships\/notesSlide$/;
const CHART_REL = /\/relationships\/chart$/;
/** SmartArt keeps its text in the data part; the drawing part repeats it. */
const DIAGRAM_DATA_REL = /\/relationships\/diagramData$/;

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[ref] ?? whole;
  });
}

/** Paragraph opener, closer, text run, line break, tab, field open/close, and
 *  table row and cell boundaries, matched together so one ordered pass can
 *  build each paragraph. */
const RUN_SCAN_RE =
  /<a:p\b[^>]*>|<\/a:p>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>|<a:tab\b[^>]*\/?>|<a:fld\b[^>]*?(\/?)>|<\/a:fld>|<a:tr\b[^>]*>|<\/a:tc>|<\/a:tr>/g;

/**
 * Every non-empty `<a:p>` paragraph in one part, in source order. A table row
 * is one line, its cells joined by tabs (a cell's own paragraphs by spaces),
 * which is how Tika and our `.docx` path render a row.
 */
export function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  let line = '';
  let inField = false;
  let row: string[] | null = null;
  let cell: string[] = [];
  const flush = () => {
    const text = line.replace(/[ \t]+$/g, '').replace(/^\s+/, '');
    if (text) (row ? cell : out).push(text);
    line = '';
  };
  for (const m of xml.matchAll(RUN_SCAN_RE)) {
    const tag = m[0];
    // `<a:p>`, `<a:p/>` or `</a:p>`: a paragraph boundary either way.
    if (tag.startsWith('<a:p') || tag === '</a:p>') {
      flush();
      continue;
    }
    if (tag.startsWith('<a:tr')) {
      flush();
      row = [];
      cell = [];
      continue;
    }
    if (tag === '</a:tc>') {
      flush();
      row?.push(cell.join(' '));
      cell = [];
      continue;
    }
    if (tag === '</a:tr>') {
      flush();
      const text = (row ?? []).join('\t').trimEnd();
      if (text.trim()) out.push(text);
      row = null;
      continue;
    }
    if (tag.startsWith('<a:fld')) {
      inField = m[2] !== '/';
      continue;
    }
    if (tag === '</a:fld>') {
      inField = false;
      continue;
    }
    if (inField) continue;
    if (tag.startsWith('<a:br')) line += '\n';
    else if (tag.startsWith('<a:tab')) line += '\t';
    else if (m[1] !== undefined) line += decodeXml(m[1]);
  }
  flush();
  return out;
}

/** Slide part paths in the order the presentation shows them. Falls back to
 *  the part numbering when the presentation part lists none it can resolve. */
async function slidesInOrder(zip: Zip): Promise<string[]> {
  const presentationPath = 'ppt/presentation.xml';
  const xml = (await zip.file(presentationPath)?.async('string')) ?? '';
  const rels = await relationshipsFor(zip, presentationPath);
  const listed = (/<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.exec(xml)?.[0] ?? '')
    .match(/<p:sldId\b[^>]*\/?>/g)
    ?.map((tag) => {
      const rId = ATTR(tag, 'r:id');
      return rId ? rels.get(rId) : undefined;
    })
    .filter((path): path is string => Boolean(path && zip.file(path)));
  if (listed && listed.length > 0) return listed;
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
}

/** The parts a slide links to, as `{ type, path }` in relationship order. */
async function relatedParts(
  zip: Zip,
  slidePath: string,
): Promise<Array<{ type: string; path: string }>> {
  const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels');
  const relsXml = await zip.file(relsPath)?.async('string');
  if (!relsXml) return [];
  const paths = await relationshipsFor(zip, slidePath);
  const out: Array<{ type: string; path: string }> = [];
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = ATTR(tag, 'Id');
    const path = id ? paths.get(id) : undefined;
    if (path) out.push({ type: ATTR(tag, 'Type') ?? '', path });
  }
  return out;
}

/** A chart's cached text and numbers (`<c:v>`) and its title runs, in
 *  source order, as one tab-joined line. */
export function chartLine(xml: string): string {
  const values: string[] = [];
  for (const m of xml.matchAll(/<c:v>([\s\S]*?)<\/c:v>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
    const v = decodeXml(m[1] ?? m[2] ?? '').trim();
    if (v) values.push(v);
  }
  return values.join('\t');
}

export async function parsePptx(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const slides: string[] = [];
  for (const slidePath of await slidesInOrder(zip)) {
    const xml = (await zip.file(slidePath)?.async('string')) ?? '';
    const related = await relatedParts(zip, slidePath);
    const read = async (rel: RegExp) => {
      const out: string[] = [];
      for (const { type, path } of related) {
        if (!rel.test(type)) continue;
        const partXml = await zip.file(path)?.async('string');
        if (partXml) out.push(partXml);
      }
      return out;
    };
    const parts = [
      paragraphsOf(xml).join('\n'),
      (await read(CHART_REL)).map(chartLine).join('\n'),
      (await read(DIAGRAM_DATA_REL)).map((d) => paragraphsOf(d).join('\n')).join('\n'),
      (await read(NOTES_REL)).map((n) => paragraphsOf(n).join('\n')).join('\n'),
    ];
    const text = parts.filter(Boolean).join('\n\n');
    if (text) slides.push(text);
  }
  return slides.join('\n\n').trim();
}

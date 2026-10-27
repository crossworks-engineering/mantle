/**
 * PowerPoint (.pptx) text, in slide order. Runs in the parser service
 * (server/parser) only.
 *
 * Decks once went to Tika, whose streaming extractor walked slides in
 * relationship-id STRING order (`rId10` before `rId7`), so any deck with
 * more than a handful of slides came back shuffled. Order is the point of a
 * deck, so we read this one format ourselves, like `.docx`; anydoc is the
 * fallback for a deck this reader cannot open (./read-document.ts).
 *
 * Slide order is the presentation's own `sldIdLst`, resolved through
 * `ppt/_rels/presentation.xml.rels`, which is the order PowerPoint shows. Per
 * slide: each `<a:p>` paragraph on its own line (shapes and groups in source
 * order, a table row as one tab-joined line), then one line per chart (its
 * cached series names, categories and values), then
 * SmartArt text, then the speaker notes. Field runs (`<a:fld>`: slide
 * number, date) are dropped; they are furniture, not content.
 *
 * Same tag-by-tag reading as `./ooxml-media.ts`, for the same reasons: the
 * input is machine-written OOXML and we only collect text runs in source
 * order. The tags are found with the linear scanner in ./xml-scan.ts (the
 * regular expressions it replaced took 9.1 s over 512 KB of unclosed
 * `<a:t>`), and every part is read under an inflate cap (./zip-guard.ts).
 * Throws on a container JSZip cannot open; `readDocumentText` turns that,
 * and an empty result, into the anydoc fallback.
 */

import { ATTR, loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';
import { TagScanner, tagsNamed, trimEndSpaceTab } from './xml-scan';

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

/**
 * Every non-empty `<a:p>` paragraph in one part, in source order. A table row
 * is one line, its cells joined by tabs (a cell's own paragraphs by spaces),
 * which is how our `.docx` path renders a row.
 *
 * One pass over the tags: a paragraph opener or closer (`<a:p>`, `<a:p/>`,
 * `</a:p>`) ends the line; a text run (`<a:t>`) adds its text, up to its
 * `</a:t>`; a line break and a tab add theirs; a field (`<a:fld>`, the slide
 * number or a date) is skipped to its close; a table row (`<a:tr>`) collects
 * its cells (`</a:tc>`) until `</a:tr>`.
 */
export function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  let line = '';
  let inField = false;
  let row: string[] | null = null;
  let cell: string[] = [];
  const flush = () => {
    const text = trimEndSpaceTab(line).replace(/^\s+/, '');
    if (text) (row ? cell : out).push(text);
    line = '';
  };
  const scan = new TagScanner(xml);
  for (let tag = scan.next(); tag; tag = scan.next()) {
    const { name } = tag;
    if (name === 'a:p') {
      flush();
      continue;
    }
    if (tag.closing) {
      if (name === 'a:tc') {
        flush();
        row?.push(cell.join(' '));
        cell = [];
      } else if (name === 'a:tr') {
        flush();
        const text = (row ?? []).join('\t').trimEnd();
        if (text.trim()) out.push(text);
        row = null;
      } else if (name === 'a:fld') {
        inField = false;
      }
      continue;
    }
    if (name === 'a:tr') {
      flush();
      row = [];
      cell = [];
      continue;
    }
    if (name === 'a:fld') {
      inField = !tag.selfClosing;
      continue;
    }
    if (name === 'a:t') {
      // `<a:t/>` holds nothing; an `<a:t>` with no close is skipped, as the
      // pattern this replaces skipped it.
      if (tag.selfClosing) continue;
      const text = scan.elementText(tag);
      if (text !== null && !inField) line += decodeXml(text);
      continue;
    }
    if (inField) continue;
    if (name === 'a:br') line += '\n';
    else if (name === 'a:tab') line += '\t';
  }
  flush();
  return out;
}

/** The `<p:sldId>` tags of the presentation's first `<p:sldIdLst>`. */
function slideIdsOf(xml: string): string[] {
  const out: string[] = [];
  let inList = false;
  const scan = new TagScanner(xml);
  for (let tag = scan.next(); tag; tag = scan.next()) {
    if (tag.name === 'p:sldIdLst') {
      if (tag.closing) break;
      inList = !tag.selfClosing;
    } else if (inList && !tag.closing && tag.name === 'p:sldId') {
      out.push(scan.text(tag));
    }
  }
  return out;
}

/** Slide part paths in the order the presentation shows them. Falls back to
 *  the part numbering when the presentation part lists none it can resolve. */
async function slidesInOrder(zip: Zip): Promise<string[]> {
  const presentationPath = 'ppt/presentation.xml';
  const xml = (await zip.file(presentationPath)?.async('string')) ?? '';
  const rels = await relationshipsFor(zip, presentationPath);
  const listed = slideIdsOf(xml)
    .map((tag) => {
      const rId = ATTR(tag, 'r:id');
      return rId ? rels.get(rId) : undefined;
    })
    .filter((path): path is string => Boolean(path && zip.file(path)));
  if (listed.length > 0) return listed;
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
  for (const tag of tagsNamed(relsXml, (name) => name === 'Relationship')) {
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
  const scan = new TagScanner(xml);
  for (let tag = scan.next(); tag; tag = scan.next()) {
    if (tag.closing || tag.selfClosing || (tag.name !== 'c:v' && tag.name !== 'a:t')) continue;
    // `<c:v>` is matched bare, as the pattern this replaces matched it.
    if (tag.name === 'c:v' && tag.end - tag.start !== 5) continue;
    const text = scan.elementText(tag);
    const v = text === null ? '' : decodeXml(text).trim();
    if (v) values.push(v);
  }
  return values.join('\t');
}

/** The deck's text. */
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

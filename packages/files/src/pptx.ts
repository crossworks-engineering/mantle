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
 * slide: each `<a:p>` paragraph on its own line (shapes, groups and table
 * cells alike, in source order), then the speaker notes. Field runs
 * (`<a:fld>`: slide number, date) are dropped; they are furniture, not
 * content.
 *
 * Same bounded regex reading as `./ooxml-media.ts`, for the same reasons: the
 * input is machine-written OOXML and we only collect text runs in source
 * order. Throws on a container JSZip cannot open; `parseDocumentBytes` turns
 * that, and an empty result, into the Tika fallback.
 */

import { ATTR, loadZip, numericSuffix, relationshipsFor, type Zip } from './ooxml-media';

const NOTES_REL = /\/relationships\/notesSlide$/;

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

/** Paragraph opener, closer, text run, line break, tab, and field open/close,
 *  matched together so one ordered pass can build each paragraph. */
const RUN_SCAN_RE =
  /<a:p\b[^>]*>|<\/a:p>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>|<a:tab\b[^>]*\/?>|<a:fld\b[^>]*?(\/?)>|<\/a:fld>/g;

/** Every non-empty `<a:p>` paragraph in one part, in source order. */
export function paragraphsOf(xml: string): string[] {
  const out: string[] = [];
  let line = '';
  let inField = false;
  const flush = () => {
    const text = line.replace(/[ \t]+$/g, '').replace(/^\s+/, '');
    if (text) out.push(text);
    line = '';
  };
  for (const m of xml.matchAll(RUN_SCAN_RE)) {
    const tag = m[0];
    // `<a:p>`, `<a:p/>` or `</a:p>`: a paragraph boundary either way.
    if (tag.startsWith('<a:p') || tag === '</a:p>') {
      flush();
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

/** The notes part a slide links to, if any. */
async function notesFor(zip: Zip, slidePath: string): Promise<string | undefined> {
  const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels');
  const relsXml = await zip.file(relsPath)?.async('string');
  if (!relsXml) return undefined;
  const all = await relationshipsFor(zip, slidePath);
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const type = ATTR(tag, 'Type') ?? '';
    const id = ATTR(tag, 'Id');
    if (id && NOTES_REL.test(type)) return all.get(id);
  }
  return undefined;
}

export async function parsePptx(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const slides: string[] = [];
  for (const slidePath of await slidesInOrder(zip)) {
    const xml = (await zip.file(slidePath)?.async('string')) ?? '';
    const parts = [paragraphsOf(xml).join('\n')];
    const notesPath = await notesFor(zip, slidePath);
    const notesXml = notesPath ? await zip.file(notesPath)?.async('string') : undefined;
    if (notesXml) parts.push(paragraphsOf(notesXml).join('\n'));
    const text = parts.filter(Boolean).join('\n\n');
    if (text) slides.push(text);
  }
  return slides.join('\n\n').trim();
}

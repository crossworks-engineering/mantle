/**
 * Autodesk DWFx → text digest, in the same shape as the DWF digest
 * (../plot-dwf/dwf.ts).
 *
 * A `.dwfx` is the XPS form of a DWF plot set: a plain zip (OPC) of XPS
 * parts, with no `(DWF ` magic and no W2D stream, so ./dwf.ts cannot read
 * it. A package may import only its own folder and the kit, so the few
 * lines it shares with the DWF reader (the descriptor's properties) are
 * here again. What it gives up readily, and what this reader takes:
 *
 *   - the page order: the `.fdseq` names the `.fdoc` parts, and each `.fdoc`
 *     names its `.fpage` parts (a file with neither: every `.fpage`, by name);
 *   - the text on each page: every `Glyphs` element's `UnicodeString`, in
 *     page order (title block, tags, notes);
 *   - the sheet names: a DWF `manifest.xml` Section whose resource `href` is
 *     the page, or whose `name` is a folder of the page's path. A page with
 *     neither is named by its number;
 *   - the sheet's `descriptor.xml` beside the page, when there is one: the
 *     source drawing, layout and author, as the DWF digest gives them.
 *
 * The vector paths and the page pictures (one raster a page on real files)
 * are not read. A page whose text is drawn as glyph indices only, with no
 * `UnicodeString`, has no text this reader can give.
 *
 * Every part is read through the zip guard (../../../zip-guard.ts), so a part
 * that lies about its size stops at the cap. Bytes that are not a zip, or a
 * zip with no `.fpage`, give '' (the extractor's honest skip). A zip that
 * cannot be opened, or whose every page is damaged, throws a named error.
 * What the digest leaves out is said on the file (../../../read-cut.ts).
 */
import { noteReadCut } from '../../../read-cut-sink';
import { isDocumentTooLarge } from '../../../read-limit';
import { loadZip, type Zip } from '../../../zip-guard';

/** Sheets read from one file. Real plot sets sit far below it. */
const MAX_PAGES = 256;
/** Characters of text kept for one sheet in the digest. */
const PAGE_TEXT_CHARS = 20_000;

export type DwfxSheet = {
  /** The manifest's sheet title, or null when no Section names the page. */
  title: string | null;
  sourceFile: string | null;
  layout: string | null;
  author: string | null;
  /** The text runs of the page, in page order. */
  runs: string[];
  /** The page's part is missing or damaged: no text was read. */
  unreadable?: true;
};

export type DwfxParsed = { sheets: DwfxSheet[]; pagesFound: number };

/** A part name as a lookup key: slashes, no leading slash, URI-decoded,
 *  lower case (OPC part names are case-insensitive). */
function partKey(path: string): string {
  let s = path.replace(/\\/g, '/').replace(/^\/+/, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // A bad escape stays as written.
  }
  return s.toLowerCase();
}

function dirOf(path: string): string {
  const p = partKey(path);
  const slash = p.lastIndexOf('/');
  return slash < 0 ? '' : p.slice(0, slash);
}

/** A reference inside a part, resolved against that part's folder. */
function resolveRef(baseDir: string, ref: string): string {
  const r = (ref.split('#')[0] ?? '').replace(/\\/g, '/');
  const parts = r.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return partKey(parts.join('/'));
}

/** XML text: the five named entities and the numeric ones. */
function unxml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeChar(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** One attribute of a tag, double or single quoted, entity-decoded. */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  if (!m) return null;
  return unxml(m[1] ?? m[2] ?? '');
}

/** Every `<tag ...>` of a part (any prefix), with quotes respected. */
function tagsOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[0]);
}

/** The `<Property name value/>` pairs of a DWF descriptor (first one of a
 *  name wins), as ../plot-dwf/dwf.ts reads them. */
function properties(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of tagsOf(xml, 'Property')) {
    const name = attrOf(tag, 'name');
    const value = attrOf(tag, 'value');
    if (name !== null && value !== null && !map.has(name)) map.set(name, value);
  }
  return map;
}

/** The text runs of one page: every Glyphs UnicodeString, in order. */
export function glyphRuns(fpage: string): string[] {
  const runs: string[] = [];
  for (const tag of tagsOf(fpage, 'Glyphs')) {
    // A leading `{}` is XPS's escape for text that starts with `{`.
    const raw = (attrOf(tag, 'UnicodeString') ?? '').replace(/^\{\}/, '');
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text) runs.push(text);
  }
  return runs;
}

async function openZip(bytes: Buffer): Promise<Zip> {
  try {
    return await loadZip(bytes);
  } catch (err) {
    if (isDocumentTooLarge(err)) throw err;
    throw new Error(`dwfx: no readable ZIP archive in container (${String(err)})`, { cause: err });
  }
}

/**
 * Open the package and read every page's sheet name, facts and text. Null
 * when the bytes are not a DWFx: not a zip, or a zip with no `.fpage`.
 */
export async function parseDwfxStructured(bytes: Buffer): Promise<DwfxParsed | null> {
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x504b0304) return null;
  const zip = await openZip(bytes);

  const names = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) names.set(partKey(name), name);
  }
  const ofType = (ext: string) => [...names.keys()].filter((k) => k.endsWith(ext)).sort(byName);
  const fpages = ofType('.fpage');
  if (fpages.length === 0) return null;

  /** A part's text; '' when it is missing. A damaged part throws. */
  const read = async (key: string): Promise<string> => {
    const real = names.get(key);
    const entry = real ? zip.file(real) : null;
    return entry ? entry.async('string') : '';
  };
  const readSoft = (key: string) =>
    read(key).catch((err: unknown) => {
      if (isDocumentTooLarge(err)) throw err;
      return '';
    });

  // Page order: the sequence, its documents, their pages.
  const fdseq = ofType('.fdseq')[0];
  const docs = fdseq
    ? tagsOf(await readSoft(fdseq), 'DocumentReference').flatMap((t) => {
        const src = attrOf(t, 'Source');
        return src ? [resolveRef(dirOf(fdseq), src)] : [];
      })
    : ofType('.fdoc');
  const order: string[] = [];
  for (const doc of docs) {
    for (const t of tagsOf(await readSoft(doc), 'PageContent')) {
      const src = attrOf(t, 'Source');
      if (src) order.push(resolveRef(dirOf(doc), src));
    }
  }
  const pages = [...new Set(order.length > 0 ? order : fpages)];

  // Sheet names from the DWF manifest(s): by the page's href, or by the
  // Section's name as a folder of the page's path.
  const titleByPage = new Map<string, string>();
  const titleByFolder = new Map<string, string>();
  for (const manifest of ofType('manifest.xml')) {
    const xml = await readSoft(manifest);
    const re = /<((?:[\w.-]+:)?Section)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1>/g;
    for (const m of xml.matchAll(re)) {
      const title = attrOf(m[2] ?? '', 'title');
      if (!title) continue;
      const name = attrOf(m[2] ?? '', 'name');
      if (name) titleByFolder.set(name.toLowerCase(), title);
      for (const r of tagsOf(m[3] ?? '', 'Resource')) {
        const href = attrOf(r, 'href');
        if (!href || !/\.fpage$/i.test(href)) continue;
        titleByPage.set(resolveRef(dirOf(manifest), href), title);
        titleByPage.set(resolveRef('', href), title);
      }
    }
  }
  const titleOf = (page: string): string | null =>
    titleByPage.get(page) ??
    page
      .split('/')
      .map((seg) => titleByFolder.get(seg))
      .find((t) => t !== undefined) ??
    null;

  const sheets: DwfxSheet[] = [];
  for (const page of pages.slice(0, MAX_PAGES)) {
    const props = properties(await readSoft(partKey(`${dirOf(page)}/descriptor.xml`)));
    const sheet: DwfxSheet = {
      title: titleOf(page),
      sourceFile: props.get('File Name') ?? null,
      layout: props.get('Layout Name') ?? null,
      author: props.get('Author') ?? null,
      runs: [],
    };
    const xml = names.has(page) ? await readSoft(page) : '';
    if (!xml) sheet.unreadable = true;
    else sheet.runs = glyphRuns(xml);
    sheets.push(sheet);
  }
  if (sheets.every((s) => s.unreadable)) {
    throw new Error(`dwfx: none of the ${pages.length} pages could be read (missing or damaged)`);
  }
  return { sheets, pagesFound: pages.length };
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * DWFx → the plain-text digest the extract pipeline indexes: a set header,
 * then one block per sheet (name, facts, text under a character budget).
 * '' when it is not a DWFx, or when no page has text or a sheet name (all
 * linework and pictures): the extractor's honest skip.
 */
export async function parseDwfx(bytes: Buffer): Promise<string> {
  const parsed = await parseDwfxStructured(bytes);
  if (!parsed) return '';
  const { sheets, pagesFound } = parsed;
  if (sheets.every((s) => s.runs.length === 0 && s.title === null)) return '';

  const read = sheets.filter((s) => !s.unreadable).length;
  if (read < pagesFound) {
    noteReadCut('dwfx_pages', { what: 'sheets', read, total: pagesFound, limit: MAX_PAGES });
  }
  const runs = { read: 0, total: 0 };

  const out: string[] = [];
  out.push(
    `DWFx drawing set, ${pagesFound} sheet${pagesFound === 1 ? '' : 's'}. ` +
      'Published plot (XPS): sheet names and the text on each sheet below; the linework and page pictures are not read.',
  );
  sheets.forEach((s, i) => {
    out.push('');
    out.push(`## Sheet ${s.title ?? i + 1}`);
    const facts: string[] = [];
    if (s.sourceFile) facts.push(`source drawing: ${s.sourceFile}`);
    if (s.layout) facts.push(`layout: ${s.layout}`);
    if (s.author) facts.push(`author: ${s.author}`);
    if (facts.length) out.push(facts.join(' · '));
    if (s.unreadable) {
      out.push('This sheet could not be read: its page part is missing or damaged.');
      return;
    }
    if (s.runs.length === 0) {
      out.push('No text on this sheet (linework or a picture only).');
      return;
    }
    const kept: string[] = [];
    let chars = 0;
    for (const r of s.runs) {
      if (chars + r.length > PAGE_TEXT_CHARS) break;
      kept.push(r);
      chars += r.length + 2;
    }
    runs.read += kept.length;
    runs.total += s.runs.length;
    const cut = s.runs.length - kept.length;
    out.push(
      `Text (${s.runs.length} runs): ${kept.join(', ')}` + (cut > 0 ? `, … and ${cut} more` : ''),
    );
  });
  if (runs.total > runs.read) noteReadCut('dwfx_text', { what: 'text runs', ...runs });
  return out.join('\n');
}

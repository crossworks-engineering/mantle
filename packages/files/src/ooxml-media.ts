/**
 * Embedded images out of the *zip-container* office formats: PowerPoint and
 * Excel (OOXML), and the OpenDocument trio (ODF).
 *
 * Word is handled elsewhere (`./docx.ts`) because mammoth already gives us a
 * properly parsed document tree. Nothing equivalent exists for decks and
 * workbooks, so this module goes to the container directly.
 *
 * ## Why not just list the media folder
 *
 * `ppt/media/` and `xl/media/` hold the picture *parts*, but the folder is a
 * bag: no order, no slide/sheet association, one entry for an image reused
 * twenty times, and numbering that reflects when a picture was first embedded
 * rather than where it appears. Since order is the point (a manual's
 * screenshots are only useful in sequence), every walk here goes through the
 * document body — slides in slide order, sheets in workbook order — and
 * resolves each reference to its part through the relationship file.
 *
 * ## On reading the XML with regular expressions
 *
 * This is a deliberate, bounded choice, not laziness. The inputs are
 * machine-generated OOXML/ODF whose relevant constructs are single
 * self-closing tags with stable attribute names (`<a:blip r:embed="rId7"/>`,
 * `<Relationship Id="rId7" Target="../media/image3.png"/>`). We never
 * interpret document semantics, only collect references *in source order* —
 * which is exactly what a streaming parser would give us at considerably more
 * machinery. The scan tolerates attribute reordering and unknown namespace
 * prefixes, and anything it fails to recognise degrades to "no images from
 * this part" rather than to a wrong answer. If this ever needs to understand
 * structure rather than spot references, swap in a real parser — don't extend
 * the patterns.
 */

import {
  describeImageBytes,
  type EmbeddedImage,
  type EmbeddedImageLocation,
} from './embedded-images';

type Zip = Awaited<ReturnType<typeof loadZip>>;

async function loadZip(bytes: Buffer) {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(bytes);
}

/** Resolve a relationship Target against the folder of the part that
 *  declared it, collapsing the `../` that OOXML uses constantly. */
function resolvePart(partPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseSegments = partPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') baseSegments.pop();
    else baseSegments.push(segment);
  }
  return baseSegments.join('/');
}

/** `<part-dir>/_rels/<part-name>.rels` — where a part's relationships live. */
function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf('/');
  return `${partPath.slice(0, idx)}/_rels/${partPath.slice(idx + 1)}.rels`;
}

const RELATIONSHIP_RE = /<Relationship\b[^>]*>/g;
const ATTR = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** rId → absolute part path, for one part's relationship file. */
async function relationshipsFor(zip: Zip, partPath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const file = zip.file(relsPathFor(partPath));
  if (!file) return out;
  const xml = await file.async('string');
  for (const tag of xml.match(RELATIONSHIP_RE) ?? []) {
    const id = ATTR(tag, 'Id');
    const target = ATTR(tag, 'Target');
    // External relationships point at a URL, not a part in this archive.
    if (!id || !target || ATTR(tag, 'TargetMode') === 'External') continue;
    out.set(id, resolvePart(partPath, target));
  }
  return out;
}

/** Picture-name/description elements and blip references, matched together so
 *  a single ordered pass can pair each image with the alt text declared just
 *  above it inside the same picture element. */
const PIC_SCAN_RE = /<\w+:cNvPr\b[^>]*\/?>|<a:blip\b[^>]*\/?>/g;

type BlipRef = { rId: string; altText?: string };

/** Every image reference in one part, in source order, each carrying the
 *  author's alt text when the picture declared any. */
function blipRefsInOrder(xml: string): BlipRef[] {
  const out: BlipRef[] = [];
  let pendingAlt: string | undefined;
  for (const tag of xml.match(PIC_SCAN_RE) ?? []) {
    if (tag.startsWith('<a:blip')) {
      const rId = ATTR(tag, 'r:embed') ?? ATTR(tag, 'r:link');
      if (rId) out.push({ rId, altText: pendingAlt });
      pendingAlt = undefined;
      continue;
    }
    // cNvPr — `descr` is the Alt Text field; `name` is the shape name, which
    // is only useful when the author renamed it (Office defaults it to
    // "Picture 3", which is noise we reject at the naming layer).
    const descr = ATTR(tag, 'descr')?.trim();
    const name = ATTR(tag, 'name')?.trim();
    pendingAlt = descr || name || undefined;
  }
  return out;
}

/** Turn ordered references into images, skipping parts that don't exist and
 *  reference targets the archive doesn't hold. */
async function collect(
  zip: Zip,
  refs: BlipRef[],
  rels: Map<string, string>,
  location: EmbeddedImageLocation | undefined,
  out: EmbeddedImage[],
): Promise<void> {
  for (const ref of refs) {
    const partPath = rels.get(ref.rId);
    if (!partPath) continue;
    const file = zip.file(partPath);
    if (!file) continue;
    const bytes = Buffer.from(await file.async('uint8array'));
    if (bytes.length === 0) continue;
    const fallbackExt = partPath.slice(partPath.lastIndexOf('.') + 1).toLowerCase();
    out.push({
      bytes,
      ordinal: out.length + 1,
      altText: ref.altText,
      location,
      ...describeImageBytes(bytes, fallbackExt),
    });
  }
}

/** Sort `slide2.xml` before `slide10.xml` — lexical order gets this wrong,
 *  and slide order IS the document order for a deck. */
function numericSuffix(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

/**
 * PowerPoint (.pptx) and Excel (.xlsx/.xlsm) images, in document order:
 * slide order for a deck, sheet order for a workbook.
 */
export async function extractOoxmlImages(bytes: Buffer, ext: string): Promise<EmbeddedImage[]> {
  const zip = await loadZip(bytes);
  const out: EmbeddedImage[] = [];

  if (ext === 'pptx') {
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => numericSuffix(a) - numericSuffix(b));
    for (const slidePath of slides) {
      const xml = await zip.file(slidePath)!.async('string');
      const rels = await relationshipsFor(zip, slidePath);
      await collect(zip, blipRefsInOrder(xml), rels, { slide: numericSuffix(slidePath) }, out);
    }
    return out;
  }

  // Workbooks: a sheet points at a drawing part, and the drawing holds the
  // pictures. Walking sheets in workbook order (rather than listing
  // xl/drawings/) keeps images attributed to the sheet they sit on.
  const sheetNames = await workbookSheetOrder(zip);
  for (const { path: sheetPath, name } of sheetNames) {
    const sheetXml = await zip.file(sheetPath)?.async('string');
    if (!sheetXml) continue;
    const sheetRels = await relationshipsFor(zip, sheetPath);
    const drawingIds = [...(sheetXml.match(/<drawing\b[^>]*\/?>/g) ?? [])]
      .map((tag) => ATTR(tag, 'r:id'))
      .filter((v): v is string => Boolean(v));
    for (const rId of drawingIds) {
      const drawingPath = sheetRels.get(rId);
      if (!drawingPath) continue;
      const drawingXml = await zip.file(drawingPath)?.async('string');
      if (!drawingXml) continue;
      const drawingRels = await relationshipsFor(zip, drawingPath);
      await collect(zip, blipRefsInOrder(drawingXml), drawingRels, { sheet: name }, out);
    }
  }
  return out;
}

/** Sheets in the order the workbook declares them, with their display names,
 *  resolved through the workbook's own relationships. */
async function workbookSheetOrder(zip: Zip): Promise<Array<{ path: string; name: string }>> {
  const workbookPath = 'xl/workbook.xml';
  const xml = await zip.file(workbookPath)?.async('string');
  if (!xml) return [];
  const rels = await relationshipsFor(zip, workbookPath);
  const out: Array<{ path: string; name: string }> = [];
  for (const tag of xml.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const rId = ATTR(tag, 'r:id');
    const name = ATTR(tag, 'name') ?? '';
    const path = rId ? rels.get(rId) : undefined;
    if (path) out.push({ path, name });
  }
  return out;
}

/** ODF stores pictures under `Pictures/` and references them from
 *  `content.xml` with `xlink:href`, in document order. */
const ODF_IMAGE_RE = /<draw:image\b[^>]*\/?>/g;

/**
 * OpenDocument (.odt / .ods / .odp) images, in document order.
 *
 * ODF is simpler than OOXML here: `content.xml` references picture parts
 * directly by path, so there is no relationship indirection to resolve.
 */
export async function extractOdfImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  const zip = await loadZip(bytes);
  const xml = await zip.file('content.xml')?.async('string');
  if (!xml) return [];
  const out: EmbeddedImage[] = [];
  for (const tag of xml.match(ODF_IMAGE_RE) ?? []) {
    const href = ATTR(tag, 'xlink:href');
    if (!href) continue;
    const partPath = href.replace(/^\.?\//, '');
    const file = zip.file(partPath);
    if (!file) continue;
    const imgBytes = Buffer.from(await file.async('uint8array'));
    if (imgBytes.length === 0) continue;
    const fallbackExt = partPath.slice(partPath.lastIndexOf('.') + 1).toLowerCase();
    out.push({
      bytes: imgBytes,
      ordinal: out.length + 1,
      ...describeImageBytes(imgBytes, fallbackExt),
    });
  }
  return out;
}

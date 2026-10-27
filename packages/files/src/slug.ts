import { createHash } from 'node:crypto';

/**
 * Slug + filename normalisation. The user expects lowercase everywhere;
 * the filesystem layer also has to satisfy Postgres ltree (labels are
 * [A-Za-z0-9_] only), so we keep two views:
 *
 *   - **Disk slug**: lowercase + dashes, e.g. "lister-printer".
 *   - **ltree label**: lowercase + underscores, e.g. "lister_printer".
 *
 * The two are interchangeable via dashToLtree / ltreeToDash. We persist
 * the ltree form on `nodes.path`; the disk form lives in `nodes.title`
 * (display + slug) and is what gets written to the filesystem.
 */

/**
 * Lowercase, replace runs of non-[a-z0-9] with a single dash, trim dashes.
 * Empty result → null so callers can reject the input.
 */
export function slugifyFolder(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s.length === 0 ? null : s;
}

/**
 * The slug of a folder a PERSON names (the tree's folders, every kind): as
 * slugifyFolder, but a name with no Latin letters or digits (Cyrillic, Greek,
 * Arabic, CJK, emoji) gets a short stable slug from its text instead of
 * being refused (folder audit C6). The display name is kept apart from the
 * slug, so people still see their own name. Null only for a blank name.
 * (Machine paths keep slugifyFolder: their slugs must not change.)
 */
export function folderSlugOf(name: string): string | null {
  const plain = slugifyFolder(name);
  if (plain) return plain;
  const text = name.trim();
  if (!text) return null;
  return `f-${createHash('sha1').update(text.normalize('NFC')).digest('hex').slice(0, 10)}`;
}

/**
 * Filenames: lowercase, allow dashes, underscores, and a single trailing
 * extension. Strip path separators and control chars. Cap at 200 chars.
 *
 * "My Doc.PDF"   → "my-doc.pdf"
 * "foo/bar.txt"  → "foobar.txt"  (separators stripped, NOT preserved)
 * "..hidden.md"  → "hidden.md"
 */
export function sanitizeFilename(raw: string): string | null {
  // Strip any path component the caller might have leaked in.
  const base = raw.replace(/^.*[\\/]/, '');
  const lower = base.toLowerCase().normalize('NFKD');
  // Allow a single dot before the extension; collapse the rest.
  const dot = lower.lastIndexOf('.');
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  const cleanStem = stem
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  const cleanExt = ext.replace(/[^a-z0-9]+/g, '').slice(0, 16);
  if (!cleanStem) return null;
  return cleanExt ? `${cleanStem}.${cleanExt}` : cleanStem;
}

/** Disk slug (kebab) → ltree label (snake). */
export function dashToLtree(slug: string): string {
  return slug.replace(/-/g, '_');
}

/** ltree label (snake) → disk slug (kebab). */
export function ltreeToDash(label: string): string {
  return label.replace(/_/g, '-');
}

/** Return the extension (no leading dot, lowercase) or ''. */
export function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The sets that drive ingestion + editor behaviour.
 *  - TEXT_EXTS: editable in the UI, `data.content` populated, extractor reads
 *    them in-process (UTF-8 is not parsing).
 *  - ANYDOC_EXTS: legacy Office, OpenDocument, RTF and EPUB, read by anydoc
 *    in the parser service (packages/files/src/anydoc.ts).
 *  - MARKUP_EXTS: HTML and XML, tags stripped in the parser service
 *    (packages/files/src/markup.ts).
 *  - LEGACY_SHEET_EXTS: legacy sheets, converted to `.xlsx` in the parser.
 *  - INGESTABLE_EXTS: union of all formats the extractor will try to read.
 *  - PREVIEWABLE_EXTS: rendered as Markdown / code preview in the UI.
 * Every format outside TEXT_EXTS is read by the parser service
 * (server/parser), the one process that opens untrusted documents.
 */
export const TEXT_EXTS = new Set<string>(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv']);
export const PREVIEWABLE_MARKDOWN_EXTS = new Set<string>(['md', 'markdown']);
/** Read by anydoc (a Rust library) in the parser service: legacy Word
 *  (.doc), PowerPoint (.ppt), LibreOffice native (.odt/.ods/.odp), Rich Text
 *  (.rtf) and e-books (.epub). The legacy sheets (.xls/.xlsb) use anydoc
 *  too, through the legacy-sheet conversion, so they are not in this set. */
export const ANYDOC_EXTS = new Set<string>(['doc', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'epub']);
/** LibreOffice native formats: text by anydoc, pictures straight from the
 *  zip (packages/files/src/ooxml-media.ts). */
export const ODF_EXTS = new Set<string>(['odt', 'ods', 'odp']);
/** Legacy sheets exceljs cannot read: converted to `.xlsx` first, through
 *  anydoc (packages/files/src/legacy-sheet.ts). */
export const LEGACY_SHEET_EXTS = new Set<string>(['xls', 'xlsb']);
/** Mostly tags, real content inside: tags stripped by the markup reader.
 *  `.xml` used to be unreadable (indexed by its filename alone), and as plain
 *  text the summary, embedding and chunks would all be dominated by element
 *  names, so retrieval would get *worse* while appearing to work (matching
 *  `<title>` rather than titles). Project's MSPDI export is recognised by
 *  content before the generic read. `.html`/`.htm` are saved web pages, the
 *  same shape. */
export const MARKUP_EXTS = new Set<string>(['html', 'htm', 'xml']);
/** TEXT_EXTS + every binary type the extractor can pull readable text from,
 *  all of them through the parser service. */
export const INGESTABLE_EXTS = new Set<string>([
  ...TEXT_EXTS,
  'pdf',
  'docx',
  'xlsx',
  'xlsm',
  ...LEGACY_SHEET_EXTS,
  'pptx',
  // Visio's zip format: shape text page by page (packages/files/src/vsdx.ts).
  // The old binary `.vsd` has no reader (EXPORT_REQUIRED_EXTS below).
  'vsdx',
  // Autodesk DWF drawing sets (published plots): the container digest, read
  // in the parser (packages/files/src/dwf.ts). Metadata + layer/label
  // digest, not vector geometry.
  'dwf',
  // AutoCAD DWG drawings: the parser's CAD tier converts and reads them
  // (packages/files/src/dwg.ts).
  'dwg',
  // AutoCAD DXF drawings (the DWG interchange twin). Same CAD route — see
  // ./dxf.ts. Deliberately NOT in TEXT_EXTS even though ASCII DXF is text:
  // raw group codes would index as garbage.
  'dxf',
  ...ANYDOC_EXTS,
  ...MARKUP_EXTS,
]);

/**
 * Audio + video containers Mantle STORES and PLAYS but does not (yet) index.
 * Deliberately NOT in INGESTABLE_EXTS: no parser can pull text from these, and
 * transcription is an explicit, paid action (the `video_ingest` tool) — never
 * something the extract sweep triggers on its own. Mirrors the media families
 * `mimeForExt` maps below. What this set drives:
 *   - the extractor records an honest `unsupported_media` terminal skip
 *     instead of indexing the filename as if it were the document;
 *   - the disk-sync watcher stores these instead of silently skipping them;
 *   - the upload-cap rejections point media at link ingestion.
 */
export const MEDIA_EXTS = new Set<string>([
  // video
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  // audio
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aac',
]);

/**
 * Formats we can NAME but deliberately cannot read, mapped to the action that
 * fixes it.
 *
 * These are the dead ends where the answer is a user action rather than a code
 * change or a retry. Without an entry here such a file falls through the whole
 * parser ladder to an empty string and gets indexed by its filename alone —
 * which looks, from the outside, exactly like a successful ingest. The user
 * believes their plan is in the brain; it isn't, and nothing ever said so.
 *
 * Microsoft Project is the case that prompted this. `.mpp` is a proprietary,
 * undocumented, version-varying binary OLE2 format: there is no JavaScript
 * reader for it, and reading one natively means MPXJ, which is Java and would
 * cost this stack a JVM sidecar. Since a plan has to leave Project as an export
 * either way, the honest move is to say so at ingest time and name the export.
 *
 * Keep the hints in the house error style — state the recovery move, not just
 * the refusal (see packages/tools/CLAUDE.md).
 */
export const EXPORT_REQUIRED_EXTS = new Map<string, string>([
  [
    'mpp',
    "Microsoft Project plans are a proprietary binary format Mantle can't read. In Project use File → Save As and choose XML (*.xml) for the full plan — tasks, resources, assignments and dependencies — then upload that. Exporting the task list as CSV or XLSX also works and becomes a queryable Table, but loses the outline hierarchy and links.",
  ],
  [
    'mpt',
    "Microsoft Project templates are a proprietary binary format Mantle can't read. Open it in Project and use File → Save As → XML (*.xml), then upload that instead.",
  ],
  // Old binary Visio (2003-2010). Apache Tika read its shape text; since the
  // parser service replaced Tika there is no reader for it, so the drawing is
  // findable by its name only until one is added. Saving as .vsdx is a menu
  // choice in any Visio since 2013, and .vsdx is read in full.
  [
    'vsd',
    'Old binary Visio drawings (.vsd) cannot be read. In Visio use File → Save As and choose Visio Drawing (*.vsdx), then upload that: its shape text and pictures are read in full. The .vsd stays findable by its name.',
  ],
  // DWFx is the XPS-based successor to DWF. Mantle reads classic DWF (.dwf);
  // the DWFx package is a different container and stream format that this
  // parser does not decode. Re-publishing is a one-click choice in the plot
  // dialog, so the honest move is to name it.
  [
    'dwfx',
    'DWFx drawings use a different container than the classic DWF Mantle can read. In AutoCAD plot/publish again choosing the "DWF" (not DWFx) format and upload that — or upload the source DWG or DXF directly, both ingest.',
  ],
]);

/** The recovery hint for a format that needs exporting, or undefined when the
 *  extension isn't one of them. */
export function exportHintForExt(ext: string): string | undefined {
  return EXPORT_REQUIRED_EXTS.get(ext.toLowerCase());
}

/** Which reader handles a given file extension. Every route but `utf8` and
 *  `none` is a reader in the parser service. Used by the `parse_document`
 *  trace step's `parser` meta — pulled out as a pure helper so both call
 *  sites (extractor + live conversational attachment) read from one source
 *  and the routing is unit-testable. `none` = no reader will try this ext
 *  (the caller will fall through to title fallback / `no_text_layer` skip). */
export type ParserRoute =
  | 'pdf-parse'
  | 'mammoth'
  /** PowerPoint, read by our own reader (./pptx.ts); anydoc is its fallback. */
  | 'pptx'
  | 'exceljs'
  /** Legacy .xls/.xlsb: converted to .xlsx via anydoc, then read by exceljs. */
  | 'legacy-sheet'
  /** Legacy Office, OpenDocument, RTF, EPUB: anydoc (./anydoc.ts). */
  | 'anydoc'
  /** HTML / XML: tags stripped (./markup.ts); MSPDI plans read as plans. */
  | 'markup'
  /** Visio .vsdx: shape text (./vsdx.ts). */
  | 'vsdx'
  | 'utf8'
  /** Autodesk DWF container: sheets/layers/labels digest (./dwf.ts). */
  | 'dwf'
  /** AutoCAD DWG: the CAD tier's registry digest (./dwg.ts). */
  | 'dwg'
  /** AutoCAD DXF: same CAD registry digest, read natively (./dxf.ts). */
  | 'dxf'
  | 'none';

export function parserRouteForExt(ext: string): ParserRoute {
  if (ext === 'pdf') return 'pdf-parse';
  if (ext === 'docx') return 'mammoth';
  if (ext === 'pptx') return 'pptx';
  if (LEGACY_SHEET_EXTS.has(ext)) return 'legacy-sheet';
  if (ext === 'xlsx' || ext === 'xlsm') return 'exceljs';
  if (ext === 'dwf') return 'dwf';
  if (ext === 'dwg') return 'dwg';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'vsdx') return 'vsdx';
  if (TEXT_EXTS.has(ext)) return 'utf8';
  if (ANYDOC_EXTS.has(ext)) return 'anydoc';
  if (MARKUP_EXTS.has(ext)) return 'markup';
  return 'none';
}

/**
 * Should this attachment be handled as an IMAGE (vision worker) rather than a
 * routed document? EXT routing wins over the client-supplied MIME: uploaders
 * send `image/vnd.dwg` for a DWG (a registered alias), and letting that mime
 * steer would ship a CAD binary to the vision worker — an empty read and a
 * false terminal skip — instead of the format's real parser. No ingestable
 * extension maps to an image format, so the exclusion is exact. Files with no
 * or an unrouted extension still follow the mime (email attachments whose
 * filename lives in the title).
 */
export function isVisionImage(ext: string, mime: string): boolean {
  if (INGESTABLE_EXTS.has(ext)) return false;
  return mime.startsWith('image/') || mimeForExt(ext).startsWith('image/');
}

/** Map an extension to a sensible MIME type. Falls back to octet-stream. */
export function mimeForExt(ext: string): string {
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'yaml':
    case 'yml':
      return 'application/yaml; charset=utf-8';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'svg':
      return 'image/svg+xml';
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'xml':
      return 'application/xml; charset=utf-8';
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsm':
      return 'application/vnd.ms-excel.sheet.macroEnabled.12';
    case 'xlsb':
      return 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';
    case 'doc':
      return 'application/msword';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'odt':
      return 'application/vnd.oasis.opendocument.text';
    case 'ods':
      return 'application/vnd.oasis.opendocument.spreadsheet';
    case 'odp':
      return 'application/vnd.oasis.opendocument.presentation';
    case 'rtf':
      return 'application/rtf';
    case 'epub':
      return 'application/epub+zip';
    case 'vsdx':
      return 'application/vnd.ms-visio.drawing';
    case 'vsd':
      return 'application/vnd.visio';
    case 'dwf':
      return 'model/vnd.dwf';
    case 'dwfx':
      return 'model/vnd.dwfx+xps';
    case 'dwg':
      // Deliberately NOT the also-registered image/vnd.dwg: a DWG is not a
      // viewable raster, and every mime.startsWith('image/') path (hollow
      // guard, previews, vision ingest) would mishandle it.
      return 'application/acad';
    case 'dxf':
      // Same reasoning as dwg: NEVER the also-registered image/vnd.dxf —
      // every image-mime path would misroute the drawing.
      return 'application/dxf';
    // ── Audio. These arrive constantly (Telegram voice notes are ogg/opus,
    // the transcriber's clips are m4a) and all fell through to octet-stream,
    // which made every media file render as a generic binary in the client.
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    // ── Video.
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    // ── Archives.
    case 'zip':
      return 'application/zip';
    case 'tar':
      return 'application/x-tar';
    case 'gz':
      return 'application/gzip';
    case '7z':
      return 'application/x-7z-compressed';
    case 'rar':
      return 'application/vnd.rar';
    // ── Images the map missed.
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'ico':
      return 'image/x-icon';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

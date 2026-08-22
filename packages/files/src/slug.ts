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
 * Four sets that drive ingestion + editor behaviour.
 *  - TEXT_EXTS: editable in the UI, `data.content` populated, extractor reads.
 *  - TIKA_EXTS: routed to the Apache Tika fallback parser (see ./tika.ts).
 *  - INGESTABLE_EXTS: union of all formats the extractor will try to read.
 *  - PREVIEWABLE_EXTS: rendered as Markdown / code preview in the UI.
 */
export const TEXT_EXTS = new Set<string>(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv']);
export const PREVIEWABLE_MARKDOWN_EXTS = new Set<string>(['md', 'markdown']);
/** Formats handled by the Tika fallback (./tika.ts) — anything our in-process
 *  parsers (pdf/docx/xlsx/text) can't handle but Tika reliably can.
 *  LibreOffice native (.odt/.ods/.odp), PowerPoint (.pptx/.ppt), legacy Word
 *  (.doc), Rich Text (.rtf), e-books (.epub), Visio diagrams (.vsdx/.vsd —
 *  Tika pulls the shape text). Tika supports more (RFC822 mail, MS Publisher,
 *  …); add slugs here as you need them. */
export const TIKA_EXTS = new Set<string>([
  'odt',
  'ods',
  'odp',
  'pptx',
  'ppt',
  'doc',
  'rtf',
  'epub',
  'vsdx',
  'vsd',
  // `.xml` was previously unreadable — not in any set, so `parserRouteForExt`
  // returned `none` and an upload was indexed by its filename alone. Tika
  // strips the markup and keeps the content, which is right for a format that
  // is mostly tags: as TEXT_EXTS the summary, embedding and chunks would all be
  // dominated by element names, so retrieval would get *worse* while appearing
  // to work (matching `<title>` rather than titles). Project's MSPDI export is
  // recognised by content before this fallback — see parseDocumentBytes.
  'xml',
]);
/** TEXT_EXTS + every binary type the extractor can pull readable text from.
 *  In-process: pdf-parse, mammoth, exceljs. Tika-routed: TIKA_EXTS. Each
 *  in-process binary type has a parser module under packages/files/src/
 *  and a branch in the extractor's readNodeBodyRaw; Tika-routed ones go
 *  through parseDocumentBytes → tika.ts. */
export const INGESTABLE_EXTS = new Set<string>([
  ...TEXT_EXTS,
  'pdf',
  'docx',
  'xlsx',
  'xls',
  'xlsm',
  'xlsb',
  ...TIKA_EXTS,
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
]);

/** The recovery hint for a format that needs exporting, or undefined when the
 *  extension isn't one of them. */
export function exportHintForExt(ext: string): string | undefined {
  return EXPORT_REQUIRED_EXTS.get(ext.toLowerCase());
}

/** Which parser tier handles a given file extension. Mirrors the dispatch
 *  in {@link parseDocumentBytes} and is used by the `parse_document` trace
 *  step's `parser` meta — pulled out as a pure helper so both call sites
 *  (extractor + live conversational attachment) read from one source and
 *  the routing is unit-testable. `none` = no parser will try this ext (the
 *  caller will fall through to title fallback / `no_text_layer` skip). */
export type ParserRoute =
  | 'pdf-parse'
  | 'mammoth'
  | 'exceljs'
  /** Legacy .xls/.xlsb: converted to .xlsx via Tika, then read by exceljs. */
  | 'legacy-sheet'
  | 'utf8'
  | 'tika'
  | 'none';
export function parserRouteForExt(ext: string): ParserRoute {
  if (ext === 'pdf') return 'pdf-parse';
  if (ext === 'docx') return 'mammoth';
  if (ext === 'xls' || ext === 'xlsb') return 'legacy-sheet';
  if (ext === 'xlsx' || ext === 'xlsm') return 'exceljs';
  if (TEXT_EXTS.has(ext)) return 'utf8';
  if (TIKA_EXTS.has(ext)) return 'tika';
  return 'none';
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

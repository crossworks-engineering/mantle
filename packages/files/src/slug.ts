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
 *  (.doc), Rich Text (.rtf), e-books (.epub). Tika supports more (RFC822
 *  mail, MS Publisher, …); add slugs here as you need them. */
export const TIKA_EXTS = new Set<string>([
  'odt', 'ods', 'odp',
  'pptx', 'ppt',
  'doc',
  'rtf',
  'epub',
]);
/** TEXT_EXTS + every binary type the extractor can pull readable text from.
 *  In-process: pdf-parse, mammoth, SheetJS. Tika-routed: TIKA_EXTS. Each
 *  in-process binary type has a parser module under packages/files/src/
 *  and a branch in the extractor's readNodeBodyRaw; Tika-routed ones go
 *  through parseDocumentBytes → tika.ts. */
export const INGESTABLE_EXTS = new Set<string>([
  ...TEXT_EXTS,
  'pdf', 'docx', 'xlsx', 'xls',
  ...TIKA_EXTS,
]);

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
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
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
    default:
      return 'application/octet-stream';
  }
}

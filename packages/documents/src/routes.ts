/**
 * The route table: Gotenberg 8.39 one to one. Every route the engine serves
 * for conversions is here with its path, the inputs it takes and its option
 * schema (schemas.ts). The HTTP API (POST /api/v1/documents/<key>), the four
 * agent tools and the mini-app broker all resolve a key here, so the surfaces
 * cannot drift from each other or from the engine.
 */
import type { z } from 'zod';
import * as S from './schemas';

export type DocumentsFamily = 'chromium' | 'libreoffice' | 'pdfengines';

/** What the route's main input is (inputs.ts resolves it):
 *  - `html`: inline `html`, or one .html file (`file_ids`), plus assets;
 *  - `markdown`: inline `markdown`, or .md files, plus an optional wrapper;
 *  - `node`: `node_id`, a page or a drawing printed through /print;
 *  - `office`: one or more files of a LibreOffice input type;
 *  - `pdf`: one or more PDF files. */
export type MainInput = 'html' | 'markdown' | 'node' | 'office' | 'pdf';

/** The extra files a route takes beside its main input, by input name. */
export type ExtraInput =
  | 'header_html'
  | 'footer_html'
  | 'watermark_file_id'
  | 'stamp_file_id'
  | 'facturx_file_id'
  | 'embed_file_ids';

export type OutputKind = 'pdf' | 'image' | 'json';

export type RouteDef = {
  /** The API key: the Gotenberg path without `/forms/`. */
  key: string;
  family: DocumentsFamily;
  /** The engine's path. */
  path: string;
  summary: string;
  input: MainInput;
  extras: readonly ExtraInput[];
  /** A single-file answer's kind; several files come back as a zip. */
  output: OutputKind;
  options: z.ZodType<Record<string, unknown>>;
};

const CHROMIUM_PDF_EXTRAS = [
  'header_html',
  'footer_html',
  'watermark_file_id',
  'stamp_file_id',
  'facturx_file_id',
  'embed_file_ids',
] as const;
const PDF_POST_EXTRAS = [
  'watermark_file_id',
  'stamp_file_id',
  'facturx_file_id',
  'embed_file_ids',
] as const;

function route(
  key: string,
  summary: string,
  input: MainInput,
  output: OutputKind,
  options: z.ZodType<Record<string, unknown>>,
  extras: readonly ExtraInput[] = [],
): RouteDef {
  const family = key.split('/')[0] as DocumentsFamily;
  return { key, family, path: `/forms/${key}`, summary, input, extras, output, options };
}

export const DOCUMENT_ROUTES: readonly RouteDef[] = [
  route(
    'chromium/convert/html',
    'HTML (inline or a file, with assets) to PDF',
    'html',
    'pdf',
    S.CONVERT_PAGE_OPTIONS,
    CHROMIUM_PDF_EXTRAS,
  ),
  route(
    'chromium/convert/markdown',
    'Markdown (inline or files, with an optional HTML wrapper) to PDF',
    'markdown',
    'pdf',
    S.CONVERT_PAGE_OPTIONS,
    CHROMIUM_PDF_EXTRAS,
  ),
  route(
    'chromium/convert/url',
    'A page or a drawing of this brain (node_id) printed to PDF',
    'node',
    'pdf',
    S.CONVERT_PAGE_OPTIONS,
    CHROMIUM_PDF_EXTRAS,
  ),
  route(
    'chromium/screenshot/html',
    'HTML (inline or a file, with assets) to a picture',
    'html',
    'image',
    S.SCREENSHOT_OPTIONS,
  ),
  route(
    'chromium/screenshot/markdown',
    'Markdown (inline or files) to a picture',
    'markdown',
    'image',
    S.SCREENSHOT_OPTIONS,
  ),
  route(
    'chromium/screenshot/url',
    'A page or a drawing of this brain (node_id) to a picture',
    'node',
    'image',
    S.SCREENSHOT_OPTIONS,
  ),
  route(
    'libreoffice/convert',
    'Office files (Word, Excel, PowerPoint, OpenDocument, RTF, images and more) to PDF',
    'office',
    'pdf',
    S.LIBREOFFICE_OPTIONS,
    PDF_POST_EXTRAS,
  ),
  route(
    'pdfengines/merge',
    'Merge PDFs into one, in alphanumeric file order',
    'pdf',
    'pdf',
    S.MERGE_OPTIONS,
    PDF_POST_EXTRAS,
  ),
  route(
    'pdfengines/split',
    'Split PDFs by interval or page ranges (a zip, or one PDF with splitUnify)',
    'pdf',
    'pdf',
    S.SPLIT_OPTIONS,
    PDF_POST_EXTRAS,
  ),
  route(
    'pdfengines/flatten',
    'Flatten form fields into static content',
    'pdf',
    'pdf',
    S.FLATTEN_OPTIONS,
  ),
  route(
    'pdfengines/convert',
    'Convert PDFs to PDF/A and/or PDF/UA',
    'pdf',
    'pdf',
    S.CONVERT_PDF_OPTIONS,
  ),
  route(
    'pdfengines/metadata/read',
    'Read the metadata of PDFs (JSON, nothing saved)',
    'pdf',
    'json',
    S.METADATA_READ_OPTIONS,
  ),
  route(
    'pdfengines/metadata/write',
    'Write XMP metadata (Author, Title, Keywords, ...) into PDFs',
    'pdf',
    'pdf',
    S.METADATA_WRITE_OPTIONS,
  ),
  route(
    'pdfengines/encrypt',
    'Encrypt PDFs with a user and/or owner password and permissions',
    'pdf',
    'pdf',
    S.ENCRYPT_OPTIONS,
  ),
  route('pdfengines/embed', 'Attach files inside PDFs', 'pdf', 'pdf', S.EMBED_OPTIONS, [
    'embed_file_ids',
    'facturx_file_id',
  ]),
  route(
    'pdfengines/watermark',
    'Watermark PDFs with text, an image or a PDF',
    'pdf',
    'pdf',
    S.WATERMARK_OPTIONS,
    ['watermark_file_id'],
  ),
  route(
    'pdfengines/stamp',
    'Stamp PDFs with text, an image or a PDF',
    'pdf',
    'pdf',
    S.STAMP_OPTIONS,
    ['stamp_file_id'],
  ),
  route(
    'pdfengines/rotate',
    'Rotate pages by 90, 180 or 270 degrees',
    'pdf',
    'pdf',
    S.ROTATE_OPTIONS,
  ),
  route(
    'pdfengines/bookmarks/read',
    'Read the bookmarks (outline) of PDFs (JSON, nothing saved)',
    'pdf',
    'json',
    S.BOOKMARKS_READ_OPTIONS,
  ),
  route(
    'pdfengines/bookmarks/write',
    'Write bookmarks (an outline) into PDFs',
    'pdf',
    'pdf',
    S.BOOKMARKS_WRITE_OPTIONS,
  ),
  route('pdfengines/optimize', 'Re-encode images to shrink PDFs', 'pdf', 'pdf', S.OPTIMIZE_OPTIONS),
  route(
    'pdfengines/factur-x',
    'Embed a Factur-X invoice XML into PDFs (PDF/A-3)',
    'pdf',
    'pdf',
    S.FACTURX_OPTIONS,
    ['facturx_file_id'],
  ),
];

const BY_KEY = new Map(DOCUMENT_ROUTES.map((r) => [r.key, r]));

/** The route for a key, or null. A key is the Gotenberg path without
 *  `/forms/` ('pdfengines/merge'); the API's path segments join to it. */
export function findRoute(key: string): RouteDef | null {
  return BY_KEY.get(key) ?? null;
}

/** The routes of one family, for a tool's `op` enum. */
export function routesOf(family: DocumentsFamily): RouteDef[] {
  return DOCUMENT_ROUTES.filter((r) => r.family === family);
}

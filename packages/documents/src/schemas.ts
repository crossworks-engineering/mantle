/**
 * The option schemas, one group per block of the Gotenberg 8.39 docs, with
 * the engine's own field names as the option names: the Gotenberg docs are
 * the docs. Every route's schema is strict (an unknown key is refused with
 * the first problem), and the fields Mantle owns (MANTLE_OWNED_FIELDS) are
 * refused before the schema runs, each with why, because they are the
 * credential and outbound-fetch surface: the package sets them itself.
 *
 * Numbers and booleans arrive as JSON values from the API, a tool or an app
 * and leave as form strings (form.ts); a string form of a number ("8.27") is
 * taken too, as the engine takes it.
 */
import { z } from 'zod';

/** The fields a caller may never set, and why. */
export const MANTLE_OWNED_FIELDS: Readonly<Record<string, string>> = {
  url: 'the engine prints only this brain (inputs.node_id names the page or drawing); a public URL is not captured in v1',
  cookies: 'the render cookie is minted for the caller by the package',
  extraHttpHeaders: 'headers are the credential surface; the package sends none',
  userAgent: 'the engine identifies itself; the package sends none',
  downloadFrom: 'the engine fetches nothing (API_DISABLE_DOWNLOAD_FROM); inputs name files by id',
  webhookUrl: 'the package calls the engine synchronously (WEBHOOK_DISABLE)',
  webhookMethod: 'the package calls the engine synchronously (WEBHOOK_DISABLE)',
  webhookErrorUrl: 'the package calls the engine synchronously (WEBHOOK_DISABLE)',
  webhookErrorMethod: 'the package calls the engine synchronously (WEBHOOK_DISABLE)',
  webhookExtraHttpHeaders: 'the package calls the engine synchronously (WEBHOOK_DISABLE)',
  files: 'the files are inputs (file_ids, html, markdown, node_id), never raw parts',
  embeds: 'attachments are inputs (embed_file_ids)',
  watermark: 'the watermark file is an input (watermark_file_id)',
  stamp: 'the stamp file is an input (stamp_file_id)',
  facturxXml: 'the Factur-X XML is an input (facturx_file_id)',
};

const bool = z.boolean();
/** A length the engine takes: a number, or a string with a unit ("210mm",
 *  "8.27in", "0.5"). */
const length = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(\.\d+)?(in|pt|cm|mm|px)?$/),
]);
const pageRanges = z.string().max(200);
const shortText = z.string().max(500);
const jsonRecord = z.record(z.string().max(120), z.unknown());
const statusCodes = z.array(z.number().int().min(100).max(599)).max(50);

/** Chromium page layout (convert routes). */
export const PAGE_PROPERTIES = {
  paperWidth: length,
  paperHeight: length,
  marginTop: length,
  marginBottom: length,
  marginLeft: length,
  marginRight: length,
  landscape: bool,
  scale: z.number().min(0.1).max(2),
  singlePage: bool,
  preferCssPageSize: bool,
  nativePageRanges: pageRanges,
  printBackground: bool,
  omitBackground: bool,
  generateDocumentOutline: bool,
  generateTaggedPdf: bool,
};

/** Chromium emulation, waits, status checks, console (convert and
 *  screenshot routes). */
export const CHROMIUM_BEHAVIOUR = {
  emulatedMediaType: z.enum(['screen', 'print']),
  emulatedMediaFeatures: z
    .array(z.object({ name: z.string().max(80), value: z.string().max(80) }))
    .max(20),
  waitDelay: z.string().regex(/^\d+(\.\d+)?(ms|s)$/),
  waitForExpression: z.string().max(2000),
  waitForSelector: z.string().max(500),
  failOnHttpStatusCodes: statusCodes,
  failOnResourceHttpStatusCodes: statusCodes,
  ignoreResourceHttpStatusDomains: z.array(z.string().max(253)).max(50),
  skipNetworkIdleEvent: bool,
  skipNetworkAlmostIdleEvent: bool,
  failOnResourceLoadingFailed: bool,
  failOnConsoleExceptions: bool,
  failOnConsoleMessageTypes: z
    .array(z.enum(['log', 'debug', 'info', 'warning', 'error', 'assert']))
    .max(6),
};

export const SCREENSHOT_PROPERTIES = {
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(20_000),
  clip: bool,
  selector: z.string().max(500),
  deviceScaleFactor: z.number().min(0.25).max(4),
  format: z.enum(['png', 'jpeg', 'webp']),
  quality: z.number().int().min(0).max(100),
  omitBackground: bool,
  optimizeForSpeed: bool,
};

/** The PDF/A and PDF/UA targets. */
export const PDFA_LEVELS = ['PDF/A-1b', 'PDF/A-2b', 'PDF/A-3b', 'PDF/A-4'] as const;
export const PDF_STANDARDS = {
  pdfa: z.enum(PDFA_LEVELS),
  pdfua: bool,
};

export const METADATA = { metadata: jsonRecord };

export const FACTURX_LEVELS = [
  'MINIMUM',
  'BASIC WL',
  'BASIC',
  'EN 16931',
  'EXTENDED',
  'XRECHNUNG',
] as const;
export const FACTURX_DOCUMENT_TYPES = [
  'INVOICE',
  'ORDER',
  'ORDER_RESPONSE',
  'ORDER_CHANGE',
] as const;
export const FACTURX = {
  facturxConformanceLevel: z.enum(FACTURX_LEVELS),
  facturxDocumentType: z.enum(FACTURX_DOCUMENT_TYPES),
  facturxVersion: z.string().max(20),
};

export const EMBEDS = {
  embedsMetadata: z.record(
    z.string().max(255),
    z.object({
      mimeType: z.string().max(120).optional(),
      relationship: z.string().max(40).optional(),
    }),
  ),
};

export const FLATTEN = { flatten: bool };

export const SPLIT = {
  splitMode: z.enum(['intervals', 'pages']),
  splitSpan: z.string().max(200),
  splitUnify: bool,
};

export const WATERMARK = {
  watermarkSource: z.enum(['text', 'image', 'pdf']),
  watermarkExpression: shortText,
  watermarkPages: pageRanges,
  watermarkOptions: jsonRecord,
};

export const STAMP = {
  stampSource: z.enum(['text', 'image', 'pdf']),
  stampExpression: shortText,
  stampPages: pageRanges,
  stampOptions: jsonRecord,
};

export const ROTATE = {
  rotateAngle: z.union([
    z.literal(90),
    z.literal(180),
    z.literal(270),
    z.enum(['90', '180', '270']),
  ]),
  rotatePages: pageRanges,
};

export const OPTIMIZE = {
  optimizeImages: bool,
  imageQuality: z.number().int().min(1).max(100),
};

export const ENCRYPT = {
  userPassword: z.string().max(128),
  ownerPassword: z.string().max(128),
  allowPrinting: bool,
  allowCopying: bool,
  allowModifying: bool,
  allowAnnotating: bool,
  allowFillingForms: bool,
  allowAssembling: bool,
};

/** Every post-processing group the convert routes and merge take. */
export const PDF_ENGINES_POST = {
  ...PDF_STANDARDS,
  ...METADATA,
  ...EMBEDS,
  ...FACTURX,
  ...FLATTEN,
  ...SPLIT,
  ...WATERMARK,
  ...STAMP,
  ...ROTATE,
  ...OPTIMIZE,
  ...ENCRYPT,
};

/** One bookmark, as read-bookmarks answers and write-bookmarks takes. */
export type Bookmark = { title: string; page: number; children: Bookmark[] };
export const BookmarkSchema: z.ZodType<Bookmark> = z.lazy(() =>
  z.object({
    title: z.string().max(500),
    page: z.number().int().min(1),
    children: z.array(BookmarkSchema).max(500).default([]),
  }),
) as z.ZodType<Bookmark>;
const bookmarks = z.union([
  z.array(BookmarkSchema).max(2000),
  z.record(z.string().max(255), z.array(BookmarkSchema).max(2000)),
]);

export const MERGE = {
  bookmarks,
  autoIndexBookmarks: bool,
  titleBookmarks: bool,
};

export const LIBREOFFICE_PROPERTIES = {
  password: z.string().max(256),
  landscape: bool,
  nativePageRanges: pageRanges,
  exportFormFields: bool,
  allowDuplicateFieldNames: bool,
  exportBookmarks: bool,
  exportBookmarksToPdfDestination: bool,
  exportPlaceholders: bool,
  exportNotes: bool,
  exportNotesPages: bool,
  exportOnlyNotesPages: bool,
  exportNotesInMargin: bool,
  convertOooTargetToPdfTarget: bool,
  exportLinksRelativeFsys: bool,
  exportHiddenSlides: bool,
  skipEmptyPages: bool,
  addOriginalDocumentAsStream: bool,
  singlePageSheets: bool,
  updateIndexes: bool,
  losslessImageCompression: bool,
  quality: z.number().int().min(1).max(100),
  reduceImageResolution: bool,
  maxImageResolution: z.union([
    z.literal(75),
    z.literal(150),
    z.literal(300),
    z.literal(600),
    z.literal(1200),
  ]),
  merge: bool,
  nativeWatermarkText: shortText,
  nativeWatermarkColor: z.number().int().min(0).max(0xffffff),
  nativeWatermarkFontHeight: z.number().int().min(0).max(1000),
  nativeWatermarkRotateAngle: z.number().int().min(-3600).max(3600),
  nativeWatermarkFontName: z.string().max(80),
  nativeTiledWatermarkText: shortText,
  initialView: z.number().int().min(0).max(2),
  initialPage: z.number().int().min(1),
  magnification: z.number().int().min(0).max(4),
  zoom: z.number().int().min(10).max(1600),
  pageLayout: z.number().int().min(0).max(3),
  firstPageOnLeft: bool,
  resizeWindowToInitialPage: bool,
  centerWindow: bool,
  openInFullScreenMode: bool,
  displayPDFDocumentTitle: bool,
  hideViewerMenubar: bool,
  hideViewerToolbar: bool,
  hideViewerWindowControls: bool,
  useTransitionEffects: bool,
  openBookmarkLevels: z.number().int().min(-1).max(10),
};

/** A strict object of optional fields: every key is a documented engine
 *  field, none required unless `required` names it. */
export function optionsSchema<S extends z.ZodRawShape>(
  shape: S,
  required: readonly (keyof S & string)[] = [],
) {
  const partial: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
    partial[k] = required.includes(k) ? v : v.optional();
  }
  return z.object(partial).strict();
}

export const CONVERT_PAGE_OPTIONS = optionsSchema({
  ...PAGE_PROPERTIES,
  ...CHROMIUM_BEHAVIOUR,
  ...PDF_ENGINES_POST,
});
export const SCREENSHOT_OPTIONS = optionsSchema({
  ...SCREENSHOT_PROPERTIES,
  ...CHROMIUM_BEHAVIOUR,
});
export const LIBREOFFICE_OPTIONS = optionsSchema({
  ...LIBREOFFICE_PROPERTIES,
  ...PDF_ENGINES_POST,
});
export const MERGE_OPTIONS = optionsSchema({ ...MERGE, ...PDF_ENGINES_POST });
export const SPLIT_OPTIONS = optionsSchema(
  {
    ...SPLIT,
    ...PDF_STANDARDS,
    ...METADATA,
    ...FLATTEN,
    ...EMBEDS,
    ...FACTURX,
    ...WATERMARK,
    ...STAMP,
    ...ROTATE,
    ...OPTIMIZE,
    ...ENCRYPT,
  },
  ['splitMode', 'splitSpan'],
);
export const FLATTEN_OPTIONS = optionsSchema({});
export const CONVERT_PDF_OPTIONS = optionsSchema(PDF_STANDARDS).refine(
  (o) => o.pdfa !== undefined || o.pdfua === true,
  {
    message: 'convert needs pdfa (PDF/A-1b, PDF/A-2b, PDF/A-3b or PDF/A-4) or pdfua: true',
  },
);
export const METADATA_READ_OPTIONS = optionsSchema({});
export const METADATA_WRITE_OPTIONS = optionsSchema(METADATA, ['metadata']);
export const ENCRYPT_OPTIONS = optionsSchema(ENCRYPT).refine(
  (o) => Boolean(o.userPassword || o.ownerPassword),
  {
    message: 'encrypt needs userPassword or ownerPassword',
  },
);
export const EMBED_OPTIONS = optionsSchema({ ...EMBEDS, ...FACTURX });
export const WATERMARK_OPTIONS = optionsSchema(WATERMARK, [
  'watermarkSource',
  'watermarkExpression',
]);
export const STAMP_OPTIONS = optionsSchema(STAMP, ['stampSource', 'stampExpression']);
export const ROTATE_OPTIONS = optionsSchema(ROTATE, ['rotateAngle']);
export const BOOKMARKS_READ_OPTIONS = optionsSchema({});
export const BOOKMARKS_WRITE_OPTIONS = optionsSchema({ bookmarks }, ['bookmarks']);
export const OPTIMIZE_OPTIONS = optionsSchema({ imageQuality: OPTIMIZE.imageQuality });
export const FACTURX_OPTIONS = optionsSchema(
  { ...FACTURX, pdfa: z.enum(['PDF/A-3a', 'PDF/A-3b', 'PDF/A-3u']), pdfua: bool },
  ['facturxConformanceLevel'],
);

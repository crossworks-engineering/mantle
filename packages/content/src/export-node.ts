/**
 * resolveExport — the one place that turns a content node into a downloadable
 * Office document. Both callers (the web `/api/export/[id]` route and the
 * `export_node` agent tool) go through here so the UI button and the assistant
 * produce identical files.
 *
 * Dispatch by node type:
 *   - `page`  → .docx  (render the stored ProseMirror doc)
 *   - `note`  → .docx  (markdown → ProseMirror via `markdownToDoc`, then render)
 *   - `table` → .xlsx  (the whole workbook: one worksheet per tab)
 *
 * Image embedding for pages is delegated to an injected `loadImage` callback so
 * this package stays free of a `@mantle/files` dependency (the caller wires it).
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { getPage } from './pages';
import { getDrawSvg } from './draws';
import { getNote } from './notes';
import { getTable } from './tables';
import { markdownToDoc } from './markdown-to-doc';
import { docToMarkdown } from './doc-to-markdown';
import { renderDocx, type LoadedImage } from './render-docx';
import { renderXlsx, renderXlsxWorkbook, type RenderXlsxSheet } from './render-xlsx';
import { tableToText, tableToCsv } from './table-to-text';

export type ExportFormat = 'docx' | 'xlsx' | 'md' | 'csv' | 'svg';
export type ExportKind = 'page' | 'note' | 'table' | 'draw';

/** Formats a node can be asked to download as (the caller picks). PDF is NOT
 *  here — it's rendered in server/web via headless Chromium against the live HTML
 *  surface, not through this pure (browser-free) package. Each node kind serves
 *  the subset it supports (page/note → docx|md; table → xlsx|md|csv) and falls
 *  back to its default for the rest. */
export type DocExportFormat = 'docx' | 'md' | 'csv' | 'xlsx' | 'svg';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
};

export type ExportResult = {
  bytes: Buffer;
  /** Sanitised basename incl. extension, e.g. `quarterly-plan.docx`. */
  filename: string;
  mimeType: string;
  format: ExportFormat;
  kind: ExportKind;
  title: string;
};

export type ResolveExportOptions = {
  loadImage?: (fileId: string) => Promise<LoadedImage | null>;
  /** Raster bytes for an embedded drawing, whose stored snapshot is SVG and so
   *  can't be embedded in Word directly. Needs a browser, so it is injected
   *  like `loadImage` rather than imported; a caller without one gets the
   *  `[drawing: …]` placeholder. Only the docx path consults it. */
  loadDraw?: (drawId: string) => Promise<LoadedImage | null>;
  /** Requested download format for a page/note. Ignored for tables (always
   *  xlsx). Defaults to `docx` when omitted (preserves the original behavior). */
  format?: DocExportFormat;
};

/** The export type a node maps to, or null if it isn't an exportable kind. */
export const EXPORTABLE_TYPES: Record<ExportKind, ExportFormat> = {
  page: 'docx',
  note: 'docx',
  table: 'xlsx',
  draw: 'svg',
};

/** Prepend the node's title as an H1 so a Markdown download opens as a titled
 *  document — parity with the Word export, which renders a title heading. */
function withTitle(title: string, body: string): string {
  const t = title.trim();
  return t ? `# ${t}\n\n${body}` : body;
}

/** title → safe basename stem (no extension). */
function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'export';
}

/**
 * Resolve a node id to a rendered Office document. Returns null when the id
 * isn't an exportable node (not found, or not a page/note/table). Throws only
 * on an unexpected render failure.
 */
export async function resolveExport(
  ownerId: string,
  nodeId: string,
  opts: ResolveExportOptions = {},
): Promise<ExportResult | null> {
  const [node] = await db
    .select({ type: nodes.type, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) return null;

  if (node.type === 'page') {
    const page = await getPage(ownerId, nodeId);
    if (!page) return null;
    if (opts.format === 'md') {
      // WYSIWYG — export the page content as-is. Like the public share surface,
      // we don't inject the page NAME as a heading: most pages already open
      // with their own H1, and the name lives in the download filename.
      const md = docToMarkdown(page.doc);
      return result(Buffer.from(md, 'utf8'), 'md', 'page', page.title);
    }
    const bytes = await renderDocx(page.doc, {
      title: page.title,
      loadImage: opts.loadImage,
      loadDraw: opts.loadDraw,
    });
    return result(bytes, 'docx', 'page', page.title);
  }

  if (node.type === 'note') {
    const note = await getNote(ownerId, nodeId);
    if (!note) return null;
    if (opts.format === 'md') {
      // Notes are stored AS markdown — just prepend the title for parity.
      const md = withTitle(note.title, note.content ?? '');
      return result(Buffer.from(md, 'utf8'), 'md', 'note', note.title);
    }
    // Notes carry drawings too: markdownToDoc turns `![alt](draw:<id>)` into
    // the same image node with a drawId, so the raster path covers both kinds.
    const doc = markdownToDoc(note.content ?? '');
    const bytes = await renderDocx(doc, {
      title: note.title,
      loadImage: opts.loadImage,
      loadDraw: opts.loadDraw,
    });
    return result(bytes, 'docx', 'note', note.title);
  }

  if (node.type === 'table') {
    const table = await getTable(ownerId, nodeId);
    if (!table) return null;
    // Markdown pipe-table + CSV are lossy text renders (like the brain index);
    // xlsx (the default) preserves cell types + totals formatting.
    if (opts.format === 'md') {
      return result(
        Buffer.from(tableToText(table.data, { title: table.title }), 'utf8'),
        'md',
        'table',
        table.title,
      );
    }
    if (opts.format === 'csv') {
      return result(Buffer.from(tableToCsv(table.data), 'utf8'), 'csv', 'table', table.title);
    }
    // .xlsx is the only format that can carry a whole workbook, so it does:
    // one worksheet per tab, in tab order. Markdown and CSV are single-grid
    // formats and keep rendering the open tab alone — flattening six tabs into
    // one CSV would silently interleave unrelated grids.
    //
    // `getTable` materialises ONE tab per call (the sqlite file is only opened
    // for the tab asked for), so a workbook costs one call per tab. A table
    // with no tab list is a pre-v2.1 single-grid table; `table.data` is it.
    const tabs = table.tabs ?? [];
    if (tabs.length <= 1) {
      const bytes = await renderXlsx(table.data, { title: table.title });
      return result(bytes, 'xlsx', 'table', table.title);
    }
    const sheets: RenderXlsxSheet[] = [];
    for (const tab of tabs) {
      // Reuse the already-materialised doc for the tab we were handed, rather
      // than opening the file a second time for it.
      const doc =
        tab.id === table.tabId
          ? table.data
          : (await getTable(ownerId, nodeId, { tabId: tab.id }))?.data;
      if (doc) sheets.push({ name: tab.name, doc });
    }
    const bytes = await renderXlsxWorkbook(sheets);
    return result(bytes, 'xlsx', 'table', table.title);
  }

  if (node.type === 'draw') {
    // The committed snapshot IS the export — already validated, fonts
    // inlined, renders anywhere. Null (nothing committed yet, or the last
    // commit carried no valid snapshot) means there is nothing to download.
    const svg = await getDrawSvg(ownerId, nodeId);
    if (!svg) return null;
    return result(Buffer.from(svg, 'utf8'), 'svg', 'draw', node.title);
  }

  return null;
}

function result(
  bytes: Buffer,
  format: ExportFormat,
  kind: ExportKind,
  title: string,
): ExportResult {
  return {
    bytes,
    filename: `${slugifyTitle(title)}.${format}`,
    mimeType: EXPORT_MIME[format],
    format,
    kind,
    title,
  };
}

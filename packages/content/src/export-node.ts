/**
 * resolveExport — the one place that turns a content node into a downloadable
 * Office document. Both callers (the web `/api/export/[id]` route and the
 * `export_node` agent tool) go through here so the UI button and the assistant
 * produce identical files.
 *
 * Dispatch by node type:
 *   - `page`  → .docx  (render the stored ProseMirror doc)
 *   - `note`  → .docx  (markdown → ProseMirror via `markdownToDoc`, then render)
 *   - `table` → .xlsx  (render the typed TableDoc)
 *
 * Image embedding for pages is delegated to an injected `loadImage` callback so
 * this package stays free of a `@mantle/files` dependency (the caller wires it).
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { getPage } from './pages';
import { getNote } from './notes';
import { getTable } from './tables';
import { markdownToDoc } from './markdown-to-doc';
import { renderDocx, type LoadedImage } from './render-docx';
import { renderXlsx } from './render-xlsx';

export type ExportFormat = 'docx' | 'xlsx';
export type ExportKind = 'page' | 'note' | 'table';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
};

/** The export type a node maps to, or null if it isn't an exportable kind. */
export const EXPORTABLE_TYPES: Record<ExportKind, ExportFormat> = {
  page: 'docx',
  note: 'docx',
  table: 'xlsx',
};

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
    const bytes = await renderDocx(page.doc, { title: page.title, loadImage: opts.loadImage });
    return result(bytes, 'docx', 'page', page.title);
  }

  if (node.type === 'note') {
    const note = await getNote(ownerId, nodeId);
    if (!note) return null;
    const doc = markdownToDoc(note.content ?? '');
    const bytes = await renderDocx(doc, { title: note.title, loadImage: opts.loadImage });
    return result(bytes, 'docx', 'note', note.title);
  }

  if (node.type === 'table') {
    const table = await getTable(ownerId, nodeId);
    if (!table) return null;
    const bytes = await renderXlsx(table.data, { title: table.title });
    return result(bytes, 'xlsx', 'table', table.title);
  }

  return null;
}

function result(bytes: Buffer, format: ExportFormat, kind: ExportKind, title: string): ExportResult {
  return {
    bytes,
    filename: `${slugifyTitle(title)}.${format}`,
    mimeType: EXPORT_MIME[format],
    format,
    kind,
    title,
  };
}

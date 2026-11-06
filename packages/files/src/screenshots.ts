/**
 * Area screenshots (docs/files.md, "Screenshots"): a PNG a login drags out
 * of the app and saves as a file. POST /api/screenshots saves one by the
 * export rule (export-home.ts saveExport, source `screenshots`), tagged
 * `screenshot` with what the client said about it in `data.screenshot`;
 * the MCP tool `screenshots` lists and shows them.
 *
 * What is here: the shared names (the tag, the cap, the filename), the PNG
 * sniff, and the two reads the MCP tool makes. Both reads run on the
 * caller's db handle, so inside a call they read in the calling login's
 * scope (the gate entered it, mcp-scope.ts): a screenshot the caller
 * cannot read is not found, never the owner's view of it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { fileRowFromNode, type FileRow } from './ops/shared';

/** The tag every screenshot carries (beside the base `file` tag). */
export const SCREENSHOT_TAG = 'screenshot';

/** The most a screenshot upload holds: 10 MB. */
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** The PNG signature: every PNG file starts with these eight bytes. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether `bytes` start with the PNG signature. */
export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/** A screenshot's filename, by the time it was saved (UTC):
 *  `screenshot-2026-11-06-101500.png`. A taken name takes the next free
 *  one when it is saved (exportNames). */
export function screenshotFilename(at: Date = new Date()): string {
  const iso = at.toISOString(); // 2026-11-06T10:15:00.000Z
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(':', '');
  return `screenshot-${day}-${time}.png`;
}

/** A screenshot as the MCP tool lists it. */
export type ScreenshotSummary = {
  id: string;
  filename: string;
  capturedAt: string | null;
  route: string | null;
  screen: string | null;
  itemTitle: string | null;
  note: string | null;
  sizeBytes: number;
};

/** One screenshot: its file row and what the client said about it. */
export type Screenshot = {
  file: FileRow;
  meta: Record<string, unknown>;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function metaOf(data: unknown): Record<string, unknown> | null {
  const m = (data as Record<string, unknown> | null)?.screenshot;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

/** A file node that is a screenshot: the tag and the saved metadata both.
 *  Built per query, so loading this module touches no table. */
function isScreenshotNode() {
  return sql`${nodes.tags} @> array[${SCREENSHOT_TAG}]::text[] and ${nodes.data} ? 'screenshot'`;
}

/** The newest `limit` screenshots the caller reads, newest first. */
export async function listScreenshots(args: {
  ownerId: string;
  limit: number;
}): Promise<ScreenshotSummary[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, args.ownerId), eq(nodes.type, 'file'), isScreenshotNode()))
    .orderBy(desc(nodes.createdAt), desc(nodes.id))
    .limit(args.limit);
  return rows.map((row) => {
    const file = fileRowFromNode(row);
    const meta = metaOf(row.data) ?? {};
    return {
      id: file.id,
      filename: file.filename,
      capturedAt: str(meta.capturedAt),
      route: str(meta.route),
      screen: str(meta.screen),
      itemTitle: str(meta.itemTitle),
      note: str(meta.note),
      sizeBytes: file.sizeBytes,
    };
  });
}

/** The screenshot `id`, when the caller reads it and it is one; else null
 *  (a file that is no screenshot and one the caller cannot read answer the
 *  same). */
export async function screenshotById(args: {
  ownerId: string;
  id: string;
}): Promise<Screenshot | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, args.id),
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        isScreenshotNode(),
      ),
    )
    .limit(1);
  const meta = row ? metaOf(row.data) : null;
  if (!row || !meta) return null;
  return { file: fileRowFromNode(row), meta };
}

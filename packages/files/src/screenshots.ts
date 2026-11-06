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
 * cannot read is not found, never the owner's view of it. Both also name
 * the calling login (`nodes.login_id = loginId`): every screenshot is
 * private to the login that took it, so a read outside row security (the
 * system pool, a scope entered wrongly) still finds only the caller's own.
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

/** The widest or tallest a screenshot may be: 16384 pixels a side. */
export const SCREENSHOT_MAX_SIDE = 16_384;

/** The most pixels a screenshot may hold: 64 megapixels (an 8K screen at
 *  twice its density is 33). The 10 MB cap bounds the file, not the
 *  picture: a PNG of one colour compresses a huge picture into a few
 *  bytes, and every reader (the thumbnail, the vision model) decodes it. */
export const SCREENSHOT_MAX_PIXELS = 64_000_000;

/** How many leading bytes `pngDimensions` reads: the signature and the
 *  IHDR chunk's length, type, width and height. */
export const PNG_HEADER_BYTES = 24;

/** The IHDR chunk's type, `IHDR` in ASCII. */
const IHDR = [0x49, 0x48, 0x44, 0x52];

/**
 * A PNG's width and height, from its IHDR header (which the PNG format
 * puts first, with a 13-byte body); null when `bytes` are no PNG or do not
 * start with one (too short, another first chunk, a zero side).
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < PNG_HEADER_BYTES || !isPngBytes(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  for (let i = 0; i < IHDR.length; i++) if (bytes[12 + i] !== IHDR[i]) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** Whether a picture of this size is over the screenshot caps. */
export function screenshotTooLarge(d: { width: number; height: number }): boolean {
  return (
    d.width > SCREENSHOT_MAX_SIDE ||
    d.height > SCREENSHOT_MAX_SIDE ||
    d.width * d.height > SCREENSHOT_MAX_PIXELS
  );
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

/** The newest `limit` screenshots the caller (`loginId`) took and reads,
 *  newest first. */
export async function listScreenshots(args: {
  ownerId: string;
  loginId: string;
  limit: number;
}): Promise<ScreenshotSummary[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.loginId, args.loginId),
        eq(nodes.type, 'file'),
        isScreenshotNode(),
      ),
    )
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

/** The screenshot `id`, when the caller (`loginId`) took it, reads it and
 *  it is one; else null (a file that is no screenshot, another login's and
 *  one the caller cannot read answer the same). */
export async function screenshotById(args: {
  ownerId: string;
  loginId: string;
  id: string;
}): Promise<Screenshot | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, args.id),
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.loginId, args.loginId),
        eq(nodes.type, 'file'),
        isScreenshotNode(),
      ),
    )
    .limit(1);
  const meta = row ? metaOf(row.data) : null;
  if (!row || !meta) return null;
  return { file: fileRowFromNode(row), meta };
}

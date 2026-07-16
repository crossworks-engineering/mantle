/**
 * Turn remote file bytes into a searchable `file` node — identical to how email
 * attachments are ingested (packages/email/src/sync.ts). Inserting the node
 * fires the `nodes_ingested_trg` trigger (migration 0018), so the extractor
 * picks it up automatically: pulls bytes from object storage, parses text,
 * summarizes, embeds, extracts entities. We do NOT add a node type — these are
 * ordinary file nodes so the whole pipeline works unchanged.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, type NewNode } from '@mantle/db';
import { hashBuffer, putContent } from '@mantle/storage';
import { extOf, mimeForExt, sanitizeFilename } from '@mantle/files';
import { ensureBranchPath } from './branch';

export interface StoredFile {
  nodeId: string;
  sha256: string;
  /** True when an existing file node (same owner + sha256) was reused. */
  deduped: boolean;
}

export async function storeRemoteFileAsNode(args: {
  ownerId: string;
  /** Full ltree path to place the file at (its branch chain is ensured). */
  path: string;
  filename: string;
  mimeType?: string;
  bytes: Buffer;
  /** Provenance tag stored on the node, e.g. 'sharepoint' | 'onedrive'. */
  source: string;
}): Promise<StoredFile> {
  const sha256 = hashBuffer(args.bytes);

  // Owner-scoped dedup: one file node per (owner, sha256). If these exact bytes
  // already exist (any source), reuse the node — it's already extracted.
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sha256' = ${sha256}`,
      ),
    )
    .limit(1);
  if (existing) return { nodeId: existing.id, sha256, deduped: true };

  await ensureBranchPath(args.ownerId, args.path);
  await putContent(args.bytes, args.mimeType ?? 'application/octet-stream');

  const filename = sanitizeFilename(args.filename) ?? 'file';
  const mime = args.mimeType ?? mimeForExt(extOf(filename));
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'file',
      title: filename,
      path: args.path,
      data: { sha256, mimeType: mime, sizeBytes: args.bytes.byteLength, source: args.source },
    } as NewNode)
    .returning({ id: nodes.id });
  if (!row) throw new Error('storeRemoteFileAsNode: insert failed');

  return { nodeId: row.id, sha256, deduped: false };
}

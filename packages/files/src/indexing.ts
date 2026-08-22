/**
 * Metadata-only indexing — the "store it, share it, don't embed it" switch.
 *
 * Some files belong in the workspace for its plumbing (folders, sharing,
 * thumbnails-to-come) and NOT in the brain: temp files, the transcriber's
 * audio clips, a photo gallery. For those, the owner flips indexing to
 * `metadata`: the node keeps a searchable spine built from what the file IS
 * (name, type, folder, tags) while its CONTENT is never read — no chunks, no
 * entity extraction, no content-derived summary. Deliberately a MODE the
 * extractor runs in, not a skip: a skipped node would be invisible to search
 * entirely, which is more than anyone asked for.
 *
 * The flag lives at `data.indexing` on file and folder nodes; absent means
 * `full`. Effectively:
 *
 *   own flag  →  nearest-ancestor folder flag  →  'full'
 *
 * so marking a folder covers everything under it, and any child can override
 * in either direction. Resolution happens at EXTRACT time (not write time):
 * moving a file, re-flagging a folder, or clearing a flag needs no stored
 * denormalisation to stay correct — the next pass just resolves again.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

export type IndexingMode = 'full' | 'metadata';

/** What a caller may SET: the two modes, or 'inherit' to clear the own flag
 *  and fall back to the ancestors. */
export type IndexingSetting = IndexingMode | 'inherit';

export type EffectiveIndexing = {
  effective: IndexingMode;
  /** Where the answer came from — the node's own flag, an ancestor folder,
   *  or the default. Lets UI show "metadata (inherited from /files/photos)". */
  source: 'own' | 'inherited' | 'default';
  /** The ancestor folder's ltree path when source='inherited'. */
  sourcePath?: string;
};

/** The node's own flag, or null when unset (= inherit). */
export function ownIndexingMode(data: Record<string, unknown> | null): IndexingMode | null {
  const v = (data ?? {}) as Record<string, unknown>;
  return v.indexing === 'metadata' ? 'metadata' : v.indexing === 'full' ? 'full' : null;
}

/**
 * Resolve the mode a node actually indexes under. One query: every ancestor
 * branch of `path` (ltree `@>`), deepest-first, first one with a flag wins.
 * A file's `path` IS its parent folder's path, so `@>` (ancestor-or-equal)
 * naturally includes the containing folder.
 */
export async function resolveEffectiveIndexing(
  ownerId: string,
  node: Pick<Node, 'path' | 'data'>,
): Promise<EffectiveIndexing> {
  const own = ownIndexingMode(node.data as Record<string, unknown> | null);
  if (own) return { effective: own, source: 'own' };

  const ancestors = await db
    .select({ path: sql<string>`${nodes.path}::text`, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path} @> ${node.path}::ltree`,
      ),
    )
    .orderBy(sql`nlevel(${nodes.path}) desc`);

  for (const a of ancestors) {
    const mode = ownIndexingMode(a.data as Record<string, unknown> | null);
    if (mode) return { effective: mode, source: 'inherited', sourcePath: a.path };
  }
  return { effective: 'full', source: 'default' };
}

/**
 * The deterministic spine text for a metadata-only file: what the file IS,
 * never what it says. This exact text becomes both the summary and the
 * embedding input, so "find my December photos" still works by name, folder
 * and tags. No LLM call — flipping a thousand-file gallery to metadata costs
 * embeddings only, and those are local.
 */
export function metadataSpineText(node: Pick<Node, 'title' | 'path' | 'tags' | 'data'>): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = typeof data.filename === 'string' ? data.filename : node.title;
  const ext = typeof data.extension === 'string' ? (data.extension as string) : '';
  const mime = typeof data.mime_type === 'string' ? (data.mime_type as string) : '';
  const tags = (node.tags ?? []).filter((t) => t !== 'file');
  const parts = [
    `${filename}${ext ? ` — ${ext.toUpperCase()} file` : ''}${mime ? ` (${mime.split(';')[0]})` : ''}`,
    `Stored in ${node.path}.`,
  ];
  if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}.`);
  parts.push('Indexed by name only — file content is not searchable by owner request.');
  return parts.join(' ');
}

/**
 * Set the indexing flag on one file or folder node, then queue re-extraction
 * for every file whose EFFECTIVE mode this changes. Returns how many were
 * queued.
 *
 * The queueing goes through the ordinary extract pipeline (notifyNodeIngested
 * → pg-boss), one job per file — never a burst loop. The metadata direction
 * is LLM-free (spine + local embedding); the full direction re-runs real
 * extraction, which is exactly what the owner asked for by turning content
 * indexing ON.
 *
 * Idempotency plumbing: the extractor's `already_extracted` guard would
 * swallow the re-run, so every re-queued file gets `extract_completed_at`
 * cleared. `data.indexing_applied` (stamped by the extractor) records which
 * mode a file was LAST indexed under, so only files whose effective mode
 * actually changed are touched — flipping a flag to the value it already has
 * queues nothing.
 */
export async function setIndexingMode(args: {
  ownerId: string;
  nodeId: string;
  mode: IndexingSetting;
}): Promise<{ node: Node; requeued: number }> {
  const [target] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.nodeId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!target) throw new Error(`setIndexingMode: node ${args.nodeId} not found`);
  if (target.type !== 'file' && target.type !== 'branch') {
    throw new Error(
      `setIndexingMode: '${target.type}' nodes don't carry an indexing flag — only files and folders do`,
    );
  }

  const data = { ...((target.data ?? {}) as Record<string, unknown>) };
  if (args.mode === 'inherit') delete data.indexing;
  else data.indexing = args.mode;
  const [updated] = await db
    .update(nodes)
    .set({ data, updatedAt: new Date() })
    .where(eq(nodes.id, target.id))
    .returning();
  if (!updated) throw new Error('setIndexingMode: update returned no row');

  // Affected files: the node itself, or every file under the folder's subtree
  // (`<@` descendant-or-equal — file paths are their parent folder's path).
  const affected =
    target.type === 'file'
      ? [updated]
      : await db
          .select()
          .from(nodes)
          .where(
            and(
              eq(nodes.ownerId, args.ownerId),
              eq(nodes.type, 'file'),
              sql`${nodes.path} <@ ${target.path}::ltree`,
            ),
          );

  let requeued = 0;
  for (const f of affected) {
    const fData = (f.data ?? {}) as Record<string, unknown>;
    const { effective } = await resolveEffectiveIndexing(args.ownerId, f);
    const applied = fData.indexing_applied === 'metadata' ? 'metadata' : 'full';
    if (effective === applied) continue; // already indexed the right way
    delete fData.extract_completed_at; // defeat the already_extracted guard
    await db.update(nodes).set({ data: fData, updatedAt: new Date() }).where(eq(nodes.id, f.id));
    await notifyNodeIngested(f.id);
    requeued++;
  }

  return { node: updated, requeued };
}

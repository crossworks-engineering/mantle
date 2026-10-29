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

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  assertItemRight,
  db,
  itemWriteVerdicts,
  markContentChanged,
  nodes,
  systemStep,
  type Node,
} from '@mantle/db';
import { InputError } from '@mantle/std';

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
 * Set the indexing flag on one file or folder node, then reset the index of
 * every file whose EFFECTIVE mode this changes and queue its re-extraction.
 * Returns how many of those files the caller reads were queued.
 *
 * Who may switch: a folder's switch is the manage of
 * the folder (its home's Moderators: it reaches every file under it); a
 * file's is the edit of the file. Asked here, in the caller's scope, before
 * the flag changes (assertItemRight), and again by the named step.
 *
 * What it reaches (the owner's rule):
 *  - a switch that REMOVES content indexing (the file's effective mode
 *    turns metadata, name only) reaches every file under the folder, ones
 *    the caller's scope does not read included: their content index is
 *    reset (privacy; no LLM call: a spine and a local embedding);
 *  - a switch that ADDS content indexing (effective full) re-queues only
 *    the files the caller's scope reads (cost safety: no LLM spend on files
 *    the caller cannot see); a hidden file picks the mode up at its next
 *    extraction, which resolves the mode then;
 *  - `requeued` counts only the files the caller reads, so no hidden file's
 *    existence is told.
 *
 * The queueing goes through the ordinary extract pipeline (markContentChanged
 * → pg-boss), one job per file — never a burst loop. The metadata direction
 * is LLM-free (spine + local embedding); the full direction re-runs real
 * extraction, which is exactly what the owner asked for by turning content
 * indexing ON.
 *
 * Idempotency plumbing: the extractor's `already_extracted` guard would
 * swallow the re-run, so every re-queued file has its index reset
 * (markContentChanged). `data.indexing_applied` (stamped by the extractor) records which
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
  if (!target) throw new InputError(`setIndexingMode: node ${args.nodeId} not found`);
  if (target.type !== 'file' && target.type !== 'branch') {
    throw new InputError(
      `setIndexingMode: '${target.type}' nodes don't carry an indexing flag — only files and folders do`,
    );
  }
  const need = target.type === 'branch' ? 'manage' : 'edit';
  // Before the flag changes: a refusal writes nothing.
  await assertItemRight(target.id, need);

  const data = { ...((target.data ?? {}) as Record<string, unknown>) };
  if (args.mode === 'inherit') delete data.indexing;
  else data.indexing = args.mode;
  const [updated] = await db
    .update(nodes)
    .set({ data, updatedAt: new Date() })
    .where(eq(nodes.id, target.id))
    .returning();
  if (!updated) throw new Error('setIndexingMode: update returned no row');

  if (target.type === 'file') {
    const requeued = await reconcileFilesIndexing(args.ownerId, [updated], 'edit');
    return { node: updated, requeued };
  }
  // Every file under the folder's subtree (`<@` descendant-or-equal: file
  // paths are their parent folder's path), brain-wide, found by the named
  // step after the folder's check: ids only.
  const under = await systemStep('reindex', { items: [target.id], need }, async () =>
    (
      await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, args.ownerId),
            eq(nodes.type, 'file'),
            sql`${nodes.path} <@ ${target.path}::ltree`,
          ),
        )
    ).map((r) => r.id),
  );
  // The ones the caller's scope reads, asked there.
  const verdicts = await itemWriteVerdicts(under, 'read');
  const readable = new Set(under.filter((id) => verdicts.get(id) === 'ok'));
  const requeued = await systemStep('reindex', { items: [target.id], need }, async () => {
    const files =
      under.length === 0 ? [] : await db.select().from(nodes).where(inArray(nodes.id, under));
    return reconcileFiles(args.ownerId, files, readable);
  });
  return { node: updated, requeued };
}

/**
 * Reset the index of every file in `files` whose LAST-APPLIED indexing mode
 * no longer matches its effective one, after a MOVE (a file dragged into a
 * name-only gallery must shed its content index, one dragged out must gain
 * it, exactly as if the flag had been flipped) or a file's own switch. The
 * named step (the checked door, so no caller skips the check): each file
 * must be one the caller's scope reads (`need`: read for
 * a move, whose files the caller moved; edit for a file's own switch); the
 * step reads each file's whole folder chain, folders the caller's scope
 * does not read included. Returns how many were queued.
 */
export async function reconcileFilesIndexing(
  ownerId: string,
  files: readonly Node[],
  need: 'read' | 'edit' = 'read',
): Promise<number> {
  if (files.length === 0) return 0;
  return systemStep('reindex', { items: files.map((f) => f.id), need }, async (allowed) => {
    // Every file passed (the step refuses otherwise): each is the caller's.
    return reconcileFiles(ownerId, files, new Set(allowed));
  });
}

/**
 * The reset of each of `files` whose effective mode changed, on the system
 * pool. `readable`: the files the caller reads. A file turned name only is
 * reset whoever reads it (its content must stop answering); a file turned
 * full is queued only when the caller reads it (M1: no LLM spend on a
 * hidden file; its next extraction resolves the mode). Counts the readable
 * ones only.
 */
async function reconcileFiles(
  ownerId: string,
  files: readonly Node[],
  readable: ReadonlySet<string>,
): Promise<number> {
  let requeued = 0;
  for (const f of files) {
    const fData = (f.data ?? {}) as Record<string, unknown>;
    const { effective } = await resolveEffectiveIndexing(ownerId, f);
    const applied = fData.indexing_applied === 'metadata' ? 'metadata' : 'full';
    if (effective === applied) continue; // already indexed the right way
    const seen = readable.has(f.id);
    if (effective === 'full' && !seen) continue; // picked up at its next extraction
    // The mode changed: the index again (the kind registry's `indexed`). The
    // reset drops the summary and the vector now, so a file turned name-only
    // stops answering from its content at once rather than when the re-run
    // lands; announced when this transaction commits.
    await db.transaction((tx) => markContentChanged(tx, { id: f.id, type: 'file' }, ['indexing']));
    if (seen) requeued++;
  }
  return requeued;
}

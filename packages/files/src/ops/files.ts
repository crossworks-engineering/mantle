/**
 * File mutations: upload, disk sync, read, rename, delete.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { promises as fsp } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import {
  diskPathForFile,
  extOf,
  isFilesPath,
  isSafeDiskBasename,
  mimeForExt,
  renameFile as renameFileOnDisk,
  sanitizeFilename,
  TEXT_EXTS,
  writeFile as writeFileOnDisk,
  deleteFile as deleteFileOnDisk,
  adoptSpooled,
  type SpooledUpload,
} from '../index';
import { derivedCountsOf, type DerivedCounts } from '../derived-counts';
import { deleteThumbnailsFor } from '../thumbnail';
import {
  db,
  draws,
  emailAttachments,
  forumUploads,
  nodes,
  notifyNodeIngested,
  type Node,
} from '@mantle/db';
import { fileRowFromNode, type FileRow } from './shared';

const TEXT_BYTE_CAP = 1_000_000; // 1 MB cap for content-in-DB caching.

/**
 * Create or replace a file under `parentPath`. Writes bytes to disk and
 * inserts/updates the `nodes` row; for text files (extension in
 * TEXT_EXTS) the content is also stashed in `data.content` so the
 * extractor / editor can skip the disk round-trip.
 *
 * For new uploads pass `overwrite=false`; for in-place edits pass true.
 */
export async function upsertFile(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
  /** The file's bytes, for callers that already hold them (MCP base64, chat
   *  attachments, generated images). Exactly one of `bytes` / `spooled`. */
  bytes?: Buffer;
  /** A streamed upload already on disk (see `spoolUpload`): adopted by rename,
   *  so a 500 MB file costs no memory here. The web uploader's path. */
  spooled?: SpooledUpload;
  overwrite?: boolean;
  /** Display title, when it should differ from the filename.
   *
   *  Filenames here are mechanical by design — sanitised, lowercased,
   *  sortable — which is right for a path and wrong for something a person
   *  or an agent reads in a search result. Extracted document images are the
   *  first caller to need the split: the file is `007-apn-manual-p12.png`
   *  while the node is "APN Manual — Step 3: Add a new APN (p12)".
   *
   *  Set once on insert and PRESERVED on later upserts of unchanged content
   *  — without that, every re-ingest would quietly reset the title back to
   *  the filename and the naming work would evaporate on the second upload. */
  title?: string;
  /** Extra `data` keys to merge onto the node — provenance for derived
   *  files (which document an image came from, where in it, at what
   *  position). Merged under the storage fields, which always win. */
  data?: Record<string, unknown>;
  /** Extra tags beyond the base `file` tag. Deduped. */
  tags?: string[];
}): Promise<FileRow> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`upsertFile: parent '${args.parentPath}' is outside the files root`);
  }
  const filename = sanitizeFilename(args.filename);
  if (!filename) {
    throw new Error(`upsertFile: invalid filename '${args.filename}'`);
  }
  const ext = extOf(filename);
  const mime = mimeForExt(ext);
  const isText = TEXT_EXTS.has(ext);

  // Make sure parent branch exists in the DB.
  const [parent] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    )
    .limit(1);
  if (!parent) {
    throw new Error(`upsertFile: parent folder '${args.parentPath}' not found`);
  }

  // Look up any existing DB row for this (folder, filename) BEFORE touching
  // disk, so we can tell a real duplicate from an orphaned disk file.
  const [existing] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`${nodes.data}->>'filename' = ${filename}`,
      ),
    )
    .limit(1);

  // Disk write. The "already exists" collision is only meaningful when a real
  // DB node owns the name. A disk file with NO node is orphan residue from an
  // interrupted upload (the disk write landed but the node insert never ran) —
  // adopt it by overwriting, so a re-upload self-heals instead of being stuck
  // forever on "already exists" with nothing in the UI to delete.
  const effectiveOverwrite = args.overwrite || !existing;
  if (!args.bytes && !args.spooled) {
    throw new Error('upsertFile: bytes or spooled required');
  }
  const written = args.spooled
    ? await adoptSpooled(args.parentPath, filename, args.spooled, {
        overwrite: effectiveOverwrite,
      })
    : await writeFileOnDisk(args.parentPath, filename, args.bytes!, {
        overwrite: effectiveOverwrite,
      });

  // Small text files are cached in the node for the editor / responder. A
  // spooled upload is read back from disk for that: never more than 1 MB.
  const content =
    isText && written.size <= TEXT_BYTE_CAP
      ? args.bytes
        ? args.bytes.toString('utf8')
        : (await fsp.readFile(written.path)).toString('utf8')
      : null;

  const newData: Record<string, unknown> = {
    ...(args.data ?? {}),
    filename,
    extension: ext,
    mime_type: mime,
    size_bytes: written.size,
    sha256: written.sha256,
    ...(content != null ? { content } : {}),
  };

  let row: Node;
  if (existing) {
    const oldData = (existing.data ?? {}) as Record<string, unknown>;
    // Preserve summary / entities from the extractor across edits unless
    // the content changed — in which case we clear them so the next
    // extractor run gets a fresh shot.
    const sameContent = oldData.sha256 === written.sha256;
    const preserved = sameContent
      ? {
          summary: oldData.summary,
          summary_model: oldData.summary_model,
          summary_at: oldData.summary_at,
          entities: oldData.entities,
        }
      : {};
    // Title: an explicit one wins; otherwise keep whatever the node already
    // carries when it differs from the filename (something deliberately
    // named it), and fall back to the filename. Blindly resetting to the
    // filename here used to erase a caller's title on every re-upsert.
    const existingTitle = typeof existing.title === 'string' ? existing.title : '';
    const nextTitle =
      args.title?.trim() ||
      (existingTitle && existingTitle !== filename ? existingTitle : filename);
    const [updated] = await db
      .update(nodes)
      .set({
        title: nextTitle,
        data: { ...preserved, ...newData },
        updatedAt: new Date(),
        ...(sameContent ? {} : { embedding: null }),
      })
      .where(eq(nodes.id, existing.id))
      .returning();
    if (!updated) throw new Error('upsertFile: update returned no row');
    row = updated;
    // Notify the extractor again only when content changed.
    if (!sameContent) {
      await notifyNodeIngested(updated.id);
    }
  } else {
    const [inserted] = await db
      .insert(nodes)
      .values({
        ownerId: args.ownerId,
        type: 'file',
        title: args.title?.trim() || filename,
        slug: filename,
        path: args.parentPath,
        data: newData,
        tags: [...new Set(['file', ...(args.tags ?? [])])],
      })
      .returning();
    if (!inserted) throw new Error('upsertFile: insert returned no row');
    row = inserted;
    // pg_notify('node_ingested') is fired by migration 0018's trigger;
    // no explicit notify needed for fresh inserts.
  }

  return fileRowFromNode(row);
}

export async function readFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ row: FileRow; bytes: Buffer; path: string } | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  const filePath = diskPathForFile(node.path, filename);
  if (!filePath) return null;
  // Prefer cached content for text files to avoid disk reads in the
  // hot path; fall back to disk for binaries.
  let bytes: Buffer;
  if (typeof data.content === 'string') {
    bytes = Buffer.from(data.content as string, 'utf8');
  } else {
    const { promises: fs } = await import('node:fs');
    try {
      bytes = await fs.readFile(filePath);
    } catch (err) {
      // Node exists but its disk bytes are gone (host-mirrored tree edited
      // out-of-band, or a half-completed delete): treat as not-found so
      // callers 404 cleanly instead of a bare ENOENT bubbling to a 500.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  return { row: fileRowFromNode(node), bytes, path: filePath };
}

/**
 * Count the nodes ingest derived from this file (extracted images,
 * auto-imported tables, pages/notes/tables from the *_from_file tools) —
 * everything whose `data.sourceFileId` points here. One GROUP BY, served by
 * the partial index from migration 0141. Re-exported by `@mantle/content`'s
 * derived module, whose `reapDerivedFromFile` is the matching delete.
 */
export async function countDerivedFromFile(args: {
  ownerId: string;
  fileId: string;
}): Promise<DerivedCounts> {
  const rows = await db
    .select({ kind: sql<string>`${nodes.type}::text`, n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, args.ownerId), sql`${nodes.data}->>'sourceFileId' = ${args.fileId}`),
    )
    .groupBy(nodes.type);
  return derivedCountsOf(rows);
}

/** Drawings whose `file_refs` still map some BinaryFile to this file node.
 *  jsonb_each_text because the keys are Excalidraw's ids, so the file node id
 *  is a VALUE in the map, not a key. */
export async function drawsReferencingFile(
  ownerId: string,
  fileId: string,
): Promise<{ id: string; title: string }[]> {
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(draws)
    .innerJoin(nodes, eq(nodes.id, draws.nodeId))
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'draw'),
        // The map alone is NOT enough. `file_refs` is append-only: nothing
        // prunes an entry when the image is deleted from the canvas, so a
        // map-only check would refuse the delete and tell the user to "remove
        // it from the drawing first" for an image they already removed, with
        // no way to comply. So confirm the image is genuinely placed: some
        // live (non-deleted) element in the committed scene — or in the
        // working draft, which is still the user's work — must reference the
        // BinaryFile id that maps to this file.
        sql`EXISTS (
          SELECT 1
          FROM jsonb_each_text(${draws.fileRefs}) AS ref
          CROSS JOIN LATERAL (
            SELECT ${draws.scene} AS doc
            UNION ALL
            SELECT COALESCE(${draws.draftScene}, '{}'::jsonb)
          ) AS scenes
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(scenes.doc -> 'elements') = 'array'
              THEN scenes.doc -> 'elements'
              ELSE '[]'::jsonb
            END
          ) AS el
          WHERE ref.value = ${fileId}
            AND el ->> 'fileId' = ref.key
            AND COALESCE((el ->> 'isDeleted')::boolean, false) = false
        )`,
      ),
    );
  return rows;
}

export async function deleteFileById(args: {
  ownerId: string;
  fileId: string;
  /** Skip the has_derived refusal. Callers set this AFTER reaping (or
   *  explicitly accepting) the file's derived nodes — see
   *  `reapDerivedFromFile` in `@mantle/content`. */
  deleteDerived?: boolean;
}): Promise<{
  ok: boolean;
  reason?: 'not_found' | 'attachment' | 'has_derived' | 'in_drawing';
  /** Populated on the in_drawing refusal: the drawings still using this image. */
  drawings?: { id: string; title: string }[];
  /** Populated on the has_derived refusal so the caller can show what a
   *  cascade would remove before asking again with `deleteDerived: true`. */
  derived?: DerivedCounts;
}> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return { ok: false, reason: 'not_found' };
  // Block deletion of a file that's an email attachment: email_attachments
  // .file_node_id is ON DELETE RESTRICT, so a bare delete would raise an FK
  // violation and surface as a 500. Return a clean refusal the caller can show
  // instead — the bytes are owned by the email; delete it from there.
  const [attachment] = await db
    .select({ id: emailAttachments.id })
    .from(emailAttachments)
    .where(eq(emailAttachments.fileNodeId, node.id))
    .limit(1);
  if (attachment) return { ok: false, reason: 'attachment' };
  // Block deletion of an image a drawing still places on its canvas. There is
  // no FK to lean on: `draws.file_refs` is a jsonb map (BinaryFile id → file
  // node id), so a bare delete used to succeed and leave the drawing quietly
  // broken — the canvas lost the image on next open while the committed
  // snapshot kept showing it, because exportToSvg inlines image bytes. Two
  // surfaces disagreeing forever, with no error anywhere. Refuse instead, and
  // name the drawings so the caller can say where to remove it.
  const inDrawings = await drawsReferencingFile(args.ownerId, node.id);
  if (inDrawings.length > 0) {
    return { ok: false, reason: 'in_drawing', drawings: inDrawings };
  }
  // Refuse when ingest derived nodes from this file and the caller hasn't
  // opted in: a bare delete would strand them (data.sourceFileId is JSONB —
  // no FK cascade reaches them). The refusal carries counts so the caller can
  // confirm, reap, and retry with the flag. Count-first keeps the failure
  // mode measurable: the dangling_source_file audit check flags anything a
  // mid-reap crash leaves behind.
  if (!args.deleteDerived) {
    const derived = await countDerivedFromFile({ ownerId: args.ownerId, fileId: node.id });
    if (derived.total > 0) return { ok: false, reason: 'has_derived', derived };
  }
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  await db.delete(nodes).where(eq(nodes.id, node.id));
  if (filename) await deleteFileOnDisk(node.path, filename);
  // Reap the cached thumbnail derivatives too — keyed by content hash, so a
  // deleted photo doesn't leave its preview behind. Best-effort.
  void deleteThumbnailsFor(typeof data.sha256 === 'string' ? (data.sha256 as string) : null);
  // A filed forum upload points here by node_id (no FK — the node is a
  // derived artifact). Clear the pointer so its member serve route 404s
  // cleanly instead of chasing a deleted node. Cheap and almost always a
  // no-op (only file nodes filed from the forum review ever match).
  await db
    .update(forumUploads)
    .set({ nodeId: null })
    .where(and(eq(forumUploads.ownerId, args.ownerId), eq(forumUploads.nodeId, node.id)));
  return { ok: true };
}

/**
 * Sync a file the watcher just observed on disk into the DB without
 * re-writing it. Differs from `upsertFile` in two ways:
 *
 *   1. Bytes are NOT written back to disk — they're already there.
 *      Calling `upsertFile` would trigger another change event and
 *      we'd loop forever.
 *   2. If the DB row already has the same sha256, we no-op. This
 *      catches editor-save-twice and our own UI writes (which set
 *      sha256 before chokidar even reports the change).
 *
 * Returns 'noop' | 'inserted' | 'updated' so the watcher can log.
 */
export async function syncFileFromDisk(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
  bytes: Buffer;
}): Promise<{ status: 'noop' | 'inserted' | 'updated'; nodeId: string | null }> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`syncFileFromDisk: parent '${args.parentPath}' is outside the files root`);
  }
  // The name is PRESERVED, not sanitised, and that is the whole point of this
  // function. `sanitizeFilename` exists to invent a safe name when WE write the
  // bytes (`upsertFile`); here the file already exists and the operator named
  // it. Sanitising lowercases, so `Plan.XML` on disk was recorded as `plan.xml`
  // — and `data.filename` is what `diskPathForFile` reconstructs the path from.
  // On a case-sensitive filesystem that path does not exist, so `loadFileBytes`
  // returned null and the extractor indexed the FILENAME ALONE while reporting
  // success. `deleteFileByPath` never sanitised, so the two halves of this
  // module also disagreed about the key and an orphaned node outlived its file.
  //
  // Validate instead of transform. `ltreeForDiskPath` already resolved this
  // against the files root and rejected anything climbing out of it, so a
  // separator or dot-segment here means the caller bypassed that guard.
  const filename = args.filename.trim();
  if (!isSafeDiskBasename(filename)) {
    throw new Error(`syncFileFromDisk: unsafe filename '${args.filename}'`);
  }
  // Compute hash locally; no disk write.
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(args.bytes).digest('hex');
  const ext = extOf(filename);
  const mime = mimeForExt(ext);
  const isText = TEXT_EXTS.has(ext);

  // Make sure the parent folder exists in the DB. If chokidar saw a
  // file under a directory we don't know about, lazy-create the
  // branch chain. The watcher caller is the one in charge of
  // mirroring whole subtrees consistently.
  const [parent] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    )
    .limit(1);
  if (!parent) {
    await ensureBranchChain(args.ownerId, args.parentPath);
  }

  const [existing] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`lower(${nodes.data}->>'filename') = lower(${filename})`,
      ),
    )
    .limit(1);

  const content =
    isText && args.bytes.byteLength <= TEXT_BYTE_CAP ? args.bytes.toString('utf8') : null;

  const newData: Record<string, unknown> = {
    filename,
    extension: ext,
    mime_type: mime,
    size_bytes: args.bytes.byteLength,
    sha256,
    ...(content != null ? { content } : {}),
  };

  if (existing) {
    const oldData = (existing.data ?? {}) as Record<string, unknown>;
    // Same bytes? Watcher fired but nothing changed — likely an
    // atime tick or our own UI write that already populated the row.
    if (oldData.sha256 === sha256) {
      return { status: 'noop', nodeId: existing.id };
    }
    // MERGE onto the existing data — never replace it. A wholesale
    // `{...newData}` here silently destroyed everything the storage fields
    // don't cover: the per-file `indexing: 'metadata'` privacy flag (a
    // host-side re-save would revert a deliberately-excluded file to FULL
    // indexing), video_ingest provenance (sourceUrl/sourceFileId), and the
    // extractor's own summary/indexing_applied bookkeeping. The stale
    // extraction fields ARE cleared — content changed, so they must be
    // recomputed — but explicitly, not by omission.
    const [updated] = await db
      .update(nodes)
      .set({
        title: filename,
        data: {
          ...oldData,
          ...newData,
          // Content changed: force a fresh extract pass (summary/embedding
          // repopulate via the node_ingested notify below).
          summary: undefined,
          extract_completed_at: undefined,
          indexing_applied: undefined,
          // A cached body from the previous bytes must not shadow the new
          // ones (newData carries `content` only for small text files).
          ...(content == null ? { content: undefined, text: undefined } : {}),
        },
        updatedAt: new Date(),
        embedding: null,
      })
      .where(eq(nodes.id, existing.id))
      .returning({ id: nodes.id });
    if (!updated) throw new Error('syncFileFromDisk: update returned no row');
    await notifyNodeIngested(updated.id);
    return { status: 'updated', nodeId: updated.id };
  }
  const [inserted] = await db
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'file',
      title: filename,
      slug: filename,
      path: args.parentPath,
      data: newData,
      tags: ['file'],
    })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error('syncFileFromDisk: insert returned no row');
  return { status: 'inserted', nodeId: inserted.id };
}

/** Delete a file row by its on-disk coordinates. Used by the watcher
 *  when a file disappears from disk. */
export async function deleteFileByPath(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
}): Promise<{ ok: boolean }> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`lower(${nodes.data}->>'filename') = lower(${args.filename})`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false };
  await db.delete(nodes).where(eq(nodes.id, node.id));
  return { ok: true };
}

/** Lazy-mkdir for an arbitrary ltree path under `files.*`. Inserts a
 *  branch node for every missing label so the watcher can pick up files
 *  created in folders the UI hasn't seen yet. */
async function ensureBranchChain(ownerId: string, ltreePath: string): Promise<void> {
  if (!isFilesPath(ltreePath)) return;
  const segments = ltreePath.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    const label = segments[i - 1]!;
    const slug = label.replace(/_/g, '-');
    await db
      .insert(nodes)
      .values({
        ownerId,
        type: 'branch',
        title: slug,
        slug,
        path: prefix,
        data: { description: '', slug },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });
  }
}

export async function renameFileById(args: {
  ownerId: string;
  fileId: string;
  /** New basename WITHOUT the extension. Extension is preserved. */
  newStem: string;
}): Promise<FileRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const oldFilename = String(data.filename ?? '');
  const ext = String(data.extension ?? extOf(oldFilename));
  const sanitisedStem = sanitizeFilename(`${args.newStem}.${ext}`);
  if (!sanitisedStem) return null;
  const newFilename = sanitisedStem;
  if (newFilename === oldFilename) return fileRowFromNode(node);
  await renameFileOnDisk(node.path, oldFilename, newFilename);
  const [updated] = await db
    .update(nodes)
    .set({
      title: newFilename,
      slug: newFilename,
      data: { ...data, filename: newFilename },
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, node.id))
    .returning();
  return updated ? fileRowFromNode(updated) : null;
}

export async function bulkDeleteFiles(args: { ownerId: string; fileIds: string[] }): Promise<{
  deleted: number;
  /** Files refused because ingest derived nodes from them — the caller shows
   *  the counts and retries the confirmed set via the cascade path. */
  hasDerived: Array<{ fileId: string; derived: DerivedCounts }>;
  /** Files refused for a reason the caller cannot resolve by confirming.
   *  Reported so a refusal is never a silent no-op: without this, deleting a
   *  guarded file returned `{deleted: 0}` and the UI said nothing at all,
   *  while a mixed selection reported "Deleted N" and quietly left the rest. */
  refused: Array<{
    fileId: string;
    reason: 'attachment' | 'in_drawing';
    drawings?: Array<{ id: string; title: string }>;
  }>;
}> {
  let deleted = 0;
  const hasDerived: Array<{ fileId: string; derived: DerivedCounts }> = [];
  const refused: Array<{
    fileId: string;
    reason: 'attachment' | 'in_drawing';
    drawings?: Array<{ id: string; title: string }>;
  }> = [];
  for (const id of args.fileIds) {
    const res = await deleteFileById({ ownerId: args.ownerId, fileId: id });
    if (res.ok) deleted++;
    else if (res.reason === 'has_derived' && res.derived) {
      hasDerived.push({ fileId: id, derived: res.derived });
    } else if (res.reason === 'in_drawing') {
      refused.push({ fileId: id, reason: 'in_drawing', drawings: res.drawings ?? [] });
    } else if (res.reason === 'attachment') {
      refused.push({ fileId: id, reason: 'attachment' });
    }
  }
  return { deleted, hasDerived, refused };
}

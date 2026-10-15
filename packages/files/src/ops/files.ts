/**
 * File mutations: upload, disk sync, read, rename, delete.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { createReadStream, promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  assertFilesFolderDepth,
  diskPathForFile,
  extOf,
  isFilesPath,
  isSafeDiskBasename,
  mimeForExt,
  renameFile as renameFileOnDisk,
  sanitizeFilename,
  TEXT_EXTS,
  foldedFilePath,
  type SpooledUpload,
} from '../index';
import {
  deleteFileIfSame,
  discardSpooled,
  discardStaged,
  fileIdentity,
  type FileIdentity,
  overwritePlacement,
  placedBytesIntact,
  placeStaged,
  stageFile,
  stageSpooled,
  type StagedFile,
} from '../disk';
import { derivedCountsOf, type DerivedCounts } from '../derived-counts';
import { deleteThumbnailsFor } from '../thumbnail';
import {
  assertNotSnapshotCopy,
  brokerLockTx,
  currentCreateHome,
  requestWriteScope,
  withViewer,
  contentChunks,
  db,
  afterOuterCommit,
  draws,
  emailAttachments,
  flipThenPlace,
  inFlipTransaction,
  type Node,
  nodes,
  changedFields,
  markContentChanged,
  oneRow,
  pgConstraint,
  StoreRefusedError,
  withDeadlockRetry,
  withHeads,
  withNodeDeleteHeads,
  withNodeInsertHeads,
  itemHomeSql,
  mayEditSql,
} from '@mantle/db';
import { getContent } from '@mantle/storage';
import { fileRowFromNode, rowNow, type FileRow } from './shared';
import { isSystemScope } from '@mantle/db/viewer';
import { ConflictError, InputError } from '@mantle/std';

const TEXT_BYTE_CAP = 1_000_000; // 1 MB cap for content-in-DB caching.

/**
 * Everything the extractor derived from a file's bytes. New bytes make each
 * of these describe a document that no longer exists, so a content change
 * drops them all; the re-extract the change notifies writes them fresh.
 * What the bytes do NOT decide stays: the `indexing` privacy flag, a derived
 * file's provenance (`sourceFileId`, `imageContext`, …), a deliberate title.
 */
export const BYTE_DERIVED_DATA_KEYS = [
  'summary',
  'summary_model',
  'summary_at',
  'entities',
  'text',
  'vision_model',
  'ocr',
  'native_pdf',
  'schemaDigest',
  'extract_completed_at',
  'extract_incomplete',
  'extract_skipped',
  'indexing_applied',
] as const;

/**
 * The `data` a file node carries after a write: merged onto what it had,
 * never replacing it. On a content change the byte-derived keys are dropped,
 * and a cached body from the old bytes too (`newData` brings `content` only
 * for small text files).
 */
export function fileDataAfterWrite(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  contentChanged: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...oldData, ...newData };
  if (!contentChanged) return next;
  for (const key of BYTE_DERIVED_DATA_KEYS) delete next[key];
  if (newData.content == null) delete next.content;
  return next;
}

/**
 * Column changes for a file whose bytes changed (the vector goes with the
 * old bytes through markContentChanged). A "migrated" mark (page_from_file
 * made a page the living copy) no longer holds: the file now has content the
 * page never saw, and the mark would keep search sending agents to the page.
 */
function columnsAfterContentChange(old: Node) {
  return old.supersededReason === 'migrated'
    ? { supersededBy: null, supersededReason: null, salience: 1 }
    : {};
}

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
  /** The login a new file is private to (nodes.login_id: only it reads the
   *  file, and its chunks and facts follow), for a create a channel makes on
   *  a login's behalf outside its scope: a Telegram chat's attachment (W7d
   *  fix round 1, M2). Set on insert, and on the watcher's row when this
   *  create lost the race to it; an existing file keeps its own. */
  loginId?: string | null;
}): Promise<FileRow> {
  if (!isFilesPath(args.parentPath)) {
    throw new InputError(`upsertFile: parent '${args.parentPath}' is outside the files root`);
  }
  const filename = sanitizeFilename(args.filename);
  if (!filename) {
    throw new InputError(`upsertFile: invalid filename '${args.filename}'`);
  }
  const ext = extOf(filename);
  const mime = mimeForExt(ext);
  const isText = TEXT_EXTS.has(ext);

  // Make sure parent branch exists in the DB. The files root is structure
  // (homed in Admin): its id is read whatever the caller's scope holds, by
  // the definer ensureFilesRootBranch asks (mantle_kind_root_id, 0293; A6b:
  // the system pool before, 'kind-root'); a folder below it in the caller's
  // scope.
  const [parent] = args.parentPath.includes('.')
    ? await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, args.ownerId),
            eq(nodes.type, 'branch'),
            sql`${nodes.path}::text = ${args.parentPath}`,
          ),
        )
        .limit(1)
    : ((await db.execute(
        sql`select r.id from (select "public"."mantle_kind_root_id"(${args.ownerId}::uuid,
                                                                  ${args.parentPath}) as id) r
             where r.id is not null`,
      )) as unknown as { id: string }[]);
  if (!parent) {
    throw new InputError(`upsertFile: parent folder '${args.parentPath}' not found`);
  }

  if (!args.bytes && !args.spooled) {
    throw new Error('upsertFile: bytes or spooled required');
  }
  // Look up any existing DB row for this (folder, filename) BEFORE touching
  // disk, so we can tell a real duplicate from an orphaned disk file. The
  // lookup is on the system pool (W6b fix round 1, H3), existence only: a
  // caller in a workspace scope (a member, an Admin user) does not see a
  // file it may not read, and took the name for free, so its write landed
  // on that file's bytes. Now a name taken by a file the caller cannot
  // read, or one it may read but not change, is refused before the disk.
  const taken = await fileNameTaken(args.ownerId, args.parentPath, filename);
  let existing: Node | undefined;
  if (taken) {
    if ((await callerSeesNode(taken.id)) === false) throw new FileNameTakenError(filename);
    const [seen] = await db.select().from(nodes).where(eq(nodes.id, taken.id)).limit(1);
    if (!seen) throw new FileNameTakenError(filename);
    // A folded member file's bytes are not in the tree (W6b), so the disk
    // cannot tell its name is taken: refuse here, whatever the case.
    if (taken.folded && (!taken.exact || !args.overwrite)) {
      throw new FileNameTakenError(filename);
    }
    if (taken.exact) {
      existing = seen;
      if (args.overwrite) {
        // A read-only snapshot copy is never overwritten (W6b fix round 1),
        // nor a file the caller may read but not change.
        assertNotSnapshotCopy(existing);
        const id = existing.id;
        if ((await inCallerScope(() => mayEditNode(id))) === false) {
          throw new FileNameTakenError(filename);
        }
      }
    }
  }

  // The bytes are staged beside their final name, under a name the watcher
  // ignores, whatever the write. A create places them once its node insert
  // wins (W8b): two creates racing for one name used to both write the
  // final path first, so the loser's bytes could end up under the winner's
  // row. A disk file with NO node is orphan residue from an interrupted
  // upload: the placing rename replaces it, so a re-upload self-heals
  // instead of being stuck forever on "already exists". Over a file a row
  // owns (A3b part 2, store-broker.ts flipThenPlace): the row is checked
  // and changed first, and the stage goes over the file as the LAST step of
  // that transaction, so a write the database refuses never touches the
  // file (it used to be written in place before the row's update).
  if (existing && !args.overwrite) {
    const finalPath = diskPathForFile(args.parentPath, filename);
    const there =
      finalPath !== null &&
      (await fsp.access(finalPath).then(
        () => true,
        () => false,
      ));
    if (there) {
      if (args.spooled) await discardSpooled(args.spooled);
      throw new ConflictError(`writeFile: '${filename}' already exists in this folder`);
    }
  }
  const staged: StagedFile = args.spooled
    ? await stageSpooled(args.parentPath, filename, args.spooled)
    : await stageFile(args.parentPath, filename, args.bytes!);
  const written = { path: staged.tempPath, sha256: staged.sha256, size: staged.size };

  // Small text files are cached in the node for the editor / responder. A
  // spooled upload is read back from disk for that: never more than 1 MB.
  let content: string | null;
  try {
    content =
      isText && written.size <= TEXT_BYTE_CAP
        ? args.bytes
          ? args.bytes.toString('utf8')
          : (await fsp.readFile(written.path)).toString('utf8')
        : null;
  } catch (err) {
    await discardStaged(staged);
    throw err;
  }

  const newData: Record<string, unknown> = {
    ...(args.data ?? {}),
    filename,
    extension: ext,
    mime_type: mime,
    size_bytes: written.size,
    sha256: written.sha256,
    ...(content != null ? { content } : {}),
  };

  // Insert first when no row owns the name. A file is unique per (owner,
  // folder, filename) (migration 0184), so the only clash left is a race:
  // another create, or the files watcher (an orphan's bytes, or a create's
  // already placed), inserted the node between our lookup and this insert.
  // A row holding the bytes this create staged IS this file: fall through
  // and update it like any existing row, so the caller's title/data/tags
  // land. A row holding other bytes is another create's file: refused as a
  // taken name, its bytes and its row left be.
  let target: Node | undefined = existing;
  // The watcher's row this create lands on (the race below): made outside
  // this create's transaction, so without the create's stamp and home.
  let raced = false;
  if (!target) {
    const toPlace = staged;
    let placed = false;
    let inserted: Node | undefined;
    try {
      // Heads first (workspaces plan U1): the folder it lands in, shared.
      [inserted] = await withDeadlockRetry(() =>
        withNodeInsertHeads(args.ownerId, [{ type: 'file', path: args.parentPath }], async (tx) => {
          const rows = await tx
            .insert(nodes)
            .values({
              ownerId: args.ownerId,
              type: 'file',
              title: args.title?.trim() || filename,
              slug: filename,
              path: args.parentPath,
              data: newData,
              tags: [...new Set(['file', ...(args.tags ?? [])])],
              ...(args.loginId ? { loginId: args.loginId } : {}),
            })
            .onConflictDoNothing({
              target: [nodes.ownerId, nodes.path, nodes.slug],
              where: sql`${nodes.slug} is not null and ${nodes.type} = 'file'`,
            })
            .returning();
          // The insert won: the bytes go into place before it commits, so a
          // create racing for the name (waiting on this row) finds them there.
          if (rows[0] && !placed) {
            await placeStaged(toPlace);
            placed = true;
          } else if (rows[0] && !(await placedBytesIntact(toPlace))) {
            // A retry (a deadlock after the bytes were placed rolled the
            // insert back): another create may have put its own bytes under
            // the name in between (fix round 1). This insert would then name
            // bytes that are not its own: refused as a taken name, and its
            // row goes with the rollback.
            throw new FileNameTakenError(filename);
          }
          return rows;
        }),
      );
    } catch (err) {
      await discardStaged(toPlace);
      // A create racing for the name can also trip the folder's filename
      // index (0022) rather than the slug one the insert names: the same
      // lost race, refused below like the conflict.
      if (pgConstraint(err) !== 'file_filename_in_parent_uq') throw err;
    }
    // pg_notify('node_ingested') is fired by migration 0018's trigger;
    // no explicit notify needed for fresh inserts.
    if (inserted) return fileRowFromNode(inserted);
    // Lost the race: this create's bytes never reach the final name.
    await discardStaged(toPlace);
    [target] = await db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, args.ownerId),
          eq(nodes.type, 'file'),
          sql`${nodes.path}::text = ${args.parentPath}`,
          eq(nodes.slug, filename),
        ),
      )
      .limit(1);
    // No row the caller reads: the create that won is not the caller's to
    // see (fix round 1), or it went again. Either way the name was taken.
    if (!target) throw new FileNameTakenError(filename);
    if ((target.data as Record<string, unknown> | null)?.sha256 !== written.sha256) {
      throw new FileNameTakenError(filename);
    }
    // The same bytes: this create updates the row it lost to (its title,
    // data, tags), so it must be a row the caller may change, as an
    // overwrite must (fix round 1): never a snapshot copy, never a file the
    // caller may read but not edit.
    assertNotSnapshotCopy(target);
    const wonId = target.id;
    if ((await inCallerScope(() => mayEditNode(wonId))) === false) {
      throw new FileNameTakenError(filename);
    }
    raced = true;
  }
  // A create that names a stamp and a home (a snapshot copy, W6b) and lost
  // the race to the watcher: its row is stamped and homed here, as its own
  // insert would have been (fix round 2, L-4), so a copy is never left
  // editable or homed where its create did not put it.
  const home = raced ? currentCreateHome() : null;
  const stamp = home?.stamp && Object.keys(home.stamp).length > 0 ? home.stamp : null;

  const oldData = { ...((target.data ?? {}) as Record<string, unknown>) };
  // A folded member file (W6b) overwritten: its new bytes are in the tree
  // now (written above, at its folder and name), so it no longer reads
  // from its old space's directory (fix round 1, H1).
  if (foldedFilePath(target)) delete oldData.space_file;
  // Merge onto the node's data (as syncFileFromDisk does). Rebuilding it
  // from the storage fields dropped the per-file `indexing: 'metadata'`
  // privacy flag on every editor save, so an excluded file went to full
  // indexing. On new bytes the extractor's output is cleared for a fresh run.
  const sameContent = oldData.sha256 === written.sha256;
  // Title: an explicit one wins; otherwise keep whatever the node already
  // carries when it differs from the filename (something deliberately
  // named it), and fall back to the filename. Blindly resetting to the
  // filename here used to erase a caller's title on every re-upsert.
  const existingTitle = typeof target.title === 'string' ? target.title : '';
  const nextTitle =
    args.title?.trim() || (existingTitle && existingTitle !== filename ? existingTitle : filename);
  const row = target;
  // Over a file a row owns, the stage goes over it as the flip's last step;
  // a create that lost the race to a row holding its bytes has nothing to
  // place (its stage went above).
  const placement = existing ? overwriteSteps(row.id, staged) : null;
  // Heads first (workspaces plan U1): the chunk delete below needs them.
  const flip = (place: (() => Promise<void>) | null) =>
    withDeadlockRetry(() =>
      withHeads([row.id], 'update', (tx) =>
        inFlipTransaction(async () => {
          // Only the watcher's own row takes a create's stamp and home: a row
          // another create made in the meantime is that create's item, never
          // turned into this one's copy (W6b fix round 3, L-3), and the
          // watcher's row holds the bytes this create wrote (fix round 4,
          // L-2). Checked under its heads, before anything is written;
          // refused as a taken name (409).
          const watcherRow = raced && (await isWatcherInsert(tx, row.id, written.sha256));
          if (stamp && !watcherRow) {
            throw new FileNameTakenError(filename);
          }
          // The checked statement (A3b part 2): exactly one row, else a
          // refusal (a 404), with the file untouched.
          const rows = await tx
            .update(nodes)
            .set({
              title: nextTitle,
              data: fileDataAfterWrite(oldData, newData, !sameContent),
              // Only when the caller brings tags: a plain re-upsert leaves them
              // be, and the race path above must still land them on the
              // watcher's row.
              ...(args.tags?.length
                ? { tags: [...new Set([...row.tags, 'file', ...args.tags])] }
                : {}),
              // The watcher's row of a create made for a login: that login's
              // too. Only the watcher's: a row another create made is that
              // create's file, never made private to this one's login (fix
              // round 1).
              ...(watcherRow && args.loginId && !row.loginId ? { loginId: args.loginId } : {}),
              updatedAt: new Date(),
              ...(sameContent ? {} : columnsAfterContentChange(row)),
            })
            .where(eq(nodes.id, row.id))
            .returning();
          const flipped = oneRow('files', rows, 'file');
          // New bytes: the whole index again (the kind registry's `indexed`),
          // announced when this transaction commits; a new name alone
          // re-embeds.
          const u =
            (await markContentChanged(tx, { id: flipped.id, type: 'file' }, [
              ...(sameContent ? [] : (['content'] as const)),
              ...changedFields({ title: [row.title, nextTitle] }),
            ])) ?? flipped;
          // Old passages go now, not when the re-extract lands: until then
          // (and for good, should it never run) search would quote the old
          // bytes.
          if (!sameContent) await tx.delete(contentChunks).where(eq(contentChunks.nodeId, u.id));
          const out = stamp ? await restampRacedCreate(tx, u.id, stamp, home?.createWs ?? null) : u;
          // The bytes, last: a rename over the file (its old bytes kept
          // until the flip settles).
          if (place) await place();
          return out;
        }),
      ),
    );
  const updated = placement
    ? await flipThenPlace({ ...placement, flip: (place) => flip(place) })
    : await flip(null);
  if (!updated) throw new Error('upsertFile: update returned no row');

  return fileRowFromNode(updated);
}

/**
 * The steps of an overwrite's flip (store-broker.ts flipThenPlace): the
 * stage goes over the file a row owns as the flip's last step, its old
 * bytes kept until the flip settles. Putting them back (a flip that never
 * landed, an outer transaction that rolled back) happens in one short
 * transaction holding the row's lock, and only while the file still holds
 * this write's bytes and the row does not name them: a write that landed
 * meanwhile (another caller's, once this one's transaction let the row go)
 * is never undone. Otherwise the old bytes are left to the staged-leftover
 * sweep and it is logged (A3b part 2 fix round 1, M1). The residual: when
 * this write (A) skips because B's bytes are in the file and B's own flip
 * then fails too, B puts back the bytes it kept, A's never-landed ones; the
 * true old bytes are in A's kept copy until the reaper takes it.
 */
export function overwriteSteps(
  id: string,
  staged: StagedFile,
  /** The put-back's lock transaction (tests stand in for it). */
  lockTx: typeof brokerLockTx = brokerLockTx,
) {
  const placement = overwritePlacement(staged);
  const putBack = async (why: string) => {
    if (!(await placedBytesIntact(staged))) {
      console.error(
        `[files] ${why}: another write's bytes are in the file now; the old bytes stay under a staging name for the staged-leftover sweep`,
      );
      return;
    }
    await placement.unplace();
  };
  return {
    place: placement.place,
    release: placement.release,
    discard: placement.discard,
    settle: async () => (await rowNow(id)).sha256 === staged.sha256,
    unplace: async () => {
      // Decided inside the lock: never the bytes-only branch after that,
      // whatever the read-only transaction's COMMIT does (fix round 2, N1).
      let decided = false;
      try {
        // A fresh system connection, never joined to the caller's open
        // transaction (its link would wait behind this one), and a bounded
        // lock wait (fix round 2, N3).
        await lockTx(async (q) => {
          const rows = await q(
            `select data->>'sha256' as sha from nodes where id = $1 for update`,
            [id],
          );
          decided = true;
          if (rows[0]?.sha === staged.sha256) return; // it landed: keep it
          await putBack('an overwrite that never landed');
        });
      } catch (err) {
        if (decided) {
          console.error(
            '[files] an overwrite that never landed: its put-back transaction failed after deciding:',
            err instanceof Error ? err.message : err,
          );
          return;
        }
        // The row cannot be locked in time (a caller's open transaction
        // holds it) or the database is gone: the file is put back only while
        // it holds this write's own bytes.
        console.error(
          '[files] an overwrite that never landed: its row cannot be locked:',
          err instanceof Error ? err.message : err,
        );
        await putBack('an overwrite that never landed');
      }
    },
  };
}

/**
 * Whether a file row a create raced to is the files watcher's insert (see
 * upsertFile): not a snapshot copy or a folded member file; no grant on it
 * that a login made (granted_by: nobody has shared it); its home, if it
 * has one, is where the database homes a create that names no workspace
 * (its folder's home, else Admin), never a workspace a create chose; and
 * its bytes (data.sha256) are the ones this create wrote, `sha256`, as the
 * watcher read them off disk. Any other row is another create's item (W6b
 * fix round 3, L-3; fix round 4, L-2).
 * @heads-held by upsertFile (withHeads on the row).
 */
async function isWatcherInsert(
  tx: Parameters<Parameters<typeof withHeads>[2]>[0],
  id: string,
  sha256: string,
): Promise<boolean> {
  const [r] = (await tx.execute(sql`
    select coalesce(n.data->>'sha256' = ${sha256}, false)
           and not coalesce(n.data ? 'snapshot_of' or n.data ? 'space_file', false)
           and not exists (select 1 from item_grants g
                            where g.node_id = n.id and g.granted_by is not null)
           and (${itemHomeSql('n')} is null
                or ${itemHomeSql('n')} = (select ${itemHomeSql('f')} from nodes f
                                 where f.id = "public"."mantle_parent_folder"(n.owner_id, n.type, n.path))
                or ${itemHomeSql('n')} = (select w.id from workspaces w
                                 where w.owner_id = n.owner_id and w.is_admin limit 1)) as ok
      from nodes n
     where n.id = ${id}::uuid`)) as unknown as { ok: boolean }[];
  return r?.ok === true;
}

/**
 * The create stamp and home on a row a create found made by the watcher
 * (see upsertFile): the stamp merged into its data after the write (its
 * extract_skipped at the row's own time, as 0267's create stamp trigger
 * does), then its grants replaced by one home row in `createWs`, Write off.
 * The stamp goes on before the home: on a snapshot copy the database lets
 * that home through (a private workspace, Write off) and nothing wider.
 * @heads-held by upsertFile (withHeads on the row).
 */
async function restampRacedCreate(
  tx: Parameters<Parameters<typeof withHeads>[2]>[0],
  id: string,
  stamp: Readonly<Record<string, unknown>>,
  createWs: string | null,
): Promise<Node> {
  const s = JSON.stringify(stamp);
  await tx.execute(sql`
    update nodes
       set data = case when (coalesce(data, '{}'::jsonb) || ${s}::jsonb) ? 'extract_skipped'
                       then jsonb_set(coalesce(data, '{}'::jsonb) || ${s}::jsonb, '{extract_skipped,at}',
                                      to_jsonb(greatest(clock_timestamp(), updated_at)))
                       else coalesce(data, '{}'::jsonb) || ${s}::jsonb end
     where id = ${id}::uuid`);
  if (createWs) {
    await tx.execute(sql`delete from item_grants where node_id = ${id}::uuid`);
    await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home, write)
                         values (${id}::uuid, ${createWs}::uuid, true, false)`);
  }
  const [row] = await tx.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!row) throw new Error('upsertFile: the raced row is gone');
  return row;
}

/**
 * Bytes for a file node whose content lives in OBJECT STORAGE rather than the
 * host-mirrored tree. Today that means an email attachment: sync uploads the
 * bytes and records the key on `email_attachments`, then points the row at a
 * file node — `deleteFileById` already says it plainly, "the bytes are owned by
 * the email". Nothing is ever written to disk for these.
 *
 * Returns null when this node has no attachment row, and also when the object
 * itself is gone: a missing object is the same class of fact as a missing disk
 * file, so callers 404 cleanly rather than taking a 500 from the S3 client.
 */
async function storageBytesForNode(nodeId: string): Promise<Buffer | null> {
  // An email attachment is part of the private corpus: never readable below
  // admin (member logins Phase 0b), and the team role cannot read
  // email_attachments anyway.
  if (!isSystemScope()) return null;
  const [attachment] = await db
    .select({ storageKey: emailAttachments.storageKey })
    .from(emailAttachments)
    .where(eq(emailAttachments.fileNodeId, nodeId))
    .limit(1);
  if (!attachment?.storageKey) return null;
  try {
    const { body } = await getContent(attachment.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Read one file node's bytes, from wherever they actually live.
 *
 * Three sources, in order: inline `data.content` (text files), the
 * host-mirrored disk tree, then object storage. That last fallback exists
 * because an email attachment has NO disk presence at all and no
 * `data.filename` to build a path from — so this used to return null for every
 * one of them, and `/api/files/files/<id>?raw=1` answered a chat link with
 * `{"error": "not found"}`. The document was found and linked correctly; only
 * the bytes 404'd. (2026-09-10: 267 of 268 attachments on jason-prod.)
 *
 * `path` is null when the bytes did not come from disk — no caller reads it,
 * but returning a disk path we never touched would be a lie.
 */
export async function readFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ row: FileRow; bytes: Buffer; path: string | null } | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  // A folded member file (W6b) keeps its bytes in its old space's directory.
  const filePath = foldedFilePath(node) ?? diskPathForFile(node.path, filename);

  // Prefer cached content for text files to avoid disk reads in the hot path.
  if (typeof data.content === 'string') {
    return { row: fileRowFromNode(node), bytes: Buffer.from(data.content, 'utf8'), path: filePath };
  }

  // Disk next — the normal home for an uploaded binary. A node with no usable
  // path (no `data.filename`) skips straight to storage rather than failing.
  if (filePath) {
    const { promises: fs } = await import('node:fs');
    try {
      return { row: fileRowFromNode(node), bytes: await fs.readFile(filePath), path: filePath };
    } catch (err) {
      // Bytes gone from the mirrored tree (edited out-of-band, half-completed
      // delete) — fall through to storage before giving up.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const stored = await storageBytesForNode(node.id);
  if (!stored) return null;
  return { row: fileRowFromNode(node), bytes: stored, path: null };
}

/**
 * {@link readFileById}'s streaming twin, for serving a download: the same
 * three sources in the same order, but a file on disk is opened as a stream
 * with its size from `stat`, so a large file never sits in memory. Inline text
 * and an object-storage attachment are already bounded (the inline cap, and
 * an attachment is admin-only) and come back as a one-chunk stream.
 */
export async function openFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ row: FileRow; stream: Readable; size: number } | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const row = fileRowFromNode(node);
  const whole = (bytes: Buffer) => ({ row, stream: Readable.from([bytes]), size: bytes.length });

  if (typeof data.content === 'string') return whole(Buffer.from(data.content, 'utf8'));

  const filePath = foldedFilePath(node) ?? diskPathForFile(node.path, String(data.filename ?? ''));
  if (filePath) {
    try {
      const st = await fsp.stat(filePath);
      if (st.isFile()) return { row, stream: createReadStream(filePath), size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const stored = await storageBytesForNode(node.id);
  return stored ? whole(stored) : null;
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
  // Heads first (workspaces plan U1): the file and its folder.
  // The checked statement (A3b part 2): exactly one row. A delete the
  // database's row rules left at none (a caller that may read the file but
  // not delete it) is a refusal, and the bytes stay; they used to be
  // unlinked whatever the delete did.
  // What the bytes are, read under the row's lock: the commit hook below
  // unlinks only these (fix round 2, N2).
  let was: FileIdentity | null = null;
  try {
    await withDeadlockRetry(() =>
      withNodeDeleteHeads([node.id], async (tx) => {
        const rows = await tx
          .delete(nodes)
          .where(eq(nodes.id, node.id))
          .returning({ id: nodes.id });
        oneRow('files', rows, 'file');
        if (filename && !foldedFilePath(node)) was = await fileIdentity(node.path, filename);
      }),
    );
  } catch (err) {
    if (err instanceof StoreRefusedError) return { ok: false, reason: 'not_found' };
    throw err;
  }
  // The bytes go once the row's delete has committed (a crash in between
  // leaves a file the watcher brings back, never a row without bytes).
  // A folded member file (W6b) has its bytes in its old space's directory,
  // named by its id: the tree path its name builds is another file's (fix
  // round 1, H1). Its bytes stay where they are.
  // Inside an outer transaction (a login's open write transaction, a
  // personal space) the delete was a savepoint: the bytes go once that one
  // commits, never before (fix round 1, L1).
  // Only the bytes the delete saw: a file made again under the name in the
  // same outer transaction is another inode and stays (fix round 2, N2).
  const seen = was as FileIdentity | null;
  if (seen) await afterOuterCommit(() => deleteFileIfSame(node.path, filename, seen));
  // Reap the cached thumbnail derivatives too — keyed by content hash, so a
  // deleted photo doesn't leave its preview behind. Best-effort.
  void deleteThumbnailsFor(typeof data.sha256 === 'string' ? (data.sha256 as string) : null);
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
 * Returns 'noop' | 'inserted' | 'updated' so the watcher can log, or
 * 'skipped' (logged here) for a disk file that takes a folded member file's
 * name.
 */
export async function syncFileFromDisk(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
  bytes: Buffer;
}): Promise<{ status: 'noop' | 'inserted' | 'updated' | 'skipped'; nodeId: string | null }> {
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
    // A directory made on disk deeper than the tree allows stays out of the
    // brain: the caller (the watcher) logs the refusal and moves on.
    assertFilesFolderDepth(args.parentPath, 'syncFileFromDisk');
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
        // A folded member file (W6b) is not in the tree: its bytes are in
        // its old space's directory, and a tree file of its name is another
        // file (fix round 1, H1).
        sql`not coalesce(${nodes.data} ? 'space_file', false)`,
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
    // extraction fields ARE cleared (fileDataAfterWrite), and the node's old
    // chunks with them: content changed, so all of it is recomputed by the
    // node_ingested notify below.
    // Heads first (workspaces plan U1): the chunk delete needs them.
    const [updated] = await withDeadlockRetry(() =>
      withHeads([existing.id], 'update', async (tx) => {
        const rows = await tx
          .update(nodes)
          .set({
            title: filename,
            data: fileDataAfterWrite(oldData, newData, true),
            updatedAt: new Date(),
            ...columnsAfterContentChange(existing),
          })
          .where(eq(nodes.id, existing.id))
          .returning({ id: nodes.id });
        // New bytes: the whole index again, announced at commit.
        await markContentChanged(tx, { id: existing.id, type: 'file' }, ['content']);
        await tx.delete(contentChunks).where(eq(contentChunks.nodeId, existing.id));
        return rows;
      }),
    );
    if (!updated) throw new Error('syncFileFromDisk: update returned no row');
    return { status: 'updated', nodeId: updated.id };
  }
  // No tree row of this name: a folded member file (W6b) of this name in
  // this folder, any case, has its bytes in its old space's directory, so
  // the disk cannot see the name is taken. A disk file of that name never
  // becomes a brain file beside it (a second file of one name, or, on an
  // exact name, the folded row's own by the conflict below): skipped and
  // logged, the disk file left as it is (fix round 2, L-3).
  const [folded] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`lower(${nodes.data}->>'filename') = lower(${filename})`,
        sql`coalesce(${nodes.data} ? 'space_file', false)`,
      ),
    )
    .limit(1);
  if (folded) {
    console.warn(
      `[files] SKIPPED ${args.parentPath}/${filename}: a folded member file (${folded.id}) has this name; the disk file was left as it is, no node made`,
    );
    return { status: 'skipped', nodeId: null };
  }

  // Heads first (workspaces plan U1): the folder it lands in, shared.
  const [inserted] = await withDeadlockRetry(() =>
    withNodeInsertHeads(args.ownerId, [{ type: 'file', path: args.parentPath }], (tx) =>
      tx
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
        // A file is unique per (owner, folder, filename): migration 0184. The one
        // clash left is a race: an upload wrote these bytes and inserted its node
        // between our lookup and this insert. That node IS this file; no-op.
        .onConflictDoNothing({
          target: [nodes.ownerId, nodes.path, nodes.slug],
          where: sql`${nodes.slug} is not null and ${nodes.type} = 'file'`,
        })
        .returning({ id: nodes.id }),
    ),
  );
  if (!inserted) {
    const [winner] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, args.ownerId),
          eq(nodes.type, 'file'),
          sql`${nodes.path}::text = ${args.parentPath}`,
          eq(nodes.slug, filename),
        ),
      )
      .limit(1);
    if (!winner) throw new Error('syncFileFromDisk: insert returned no row');
    return { status: 'noop', nodeId: winner.id };
  }
  return { status: 'inserted', nodeId: inserted.id };
}

/** Delete a file row by its on-disk coordinates. Used by the watcher
 *  when a file disappears from disk. */
export async function deleteFileByPath(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
}): Promise<{ ok: boolean }> {
  // One statement, the path and name in its WHERE: a move that commits
  // while this waits on the row lock is re-checked against the moved row
  // (READ COMMITTED re-evaluates the WHERE), so the watcher's unlink for the
  // old path never deletes a file that just moved (folder audit C1). A
  // select-then-delete by id did.
  const where = and(
    eq(nodes.ownerId, args.ownerId),
    eq(nodes.type, 'file'),
    sql`${nodes.path}::text = ${args.parentPath}`,
    sql`lower(${nodes.data}->>'filename') = lower(${args.filename})`,
    // A tree file gone from disk is never a folded member file (W6b): its
    // bytes are not in the tree (fix round 1, H1).
    sql`not coalesce(${nodes.data} ? 'space_file', false)`,
  );
  // Heads first (workspaces plan U1): the ids are read only to know whose
  // heads to take; the delete keeps the path and name in its WHERE, and a
  // move holds the same heads, so the re-check above still holds.
  const ids = (await db.select({ id: nodes.id }).from(nodes).where(where)).map((r) => r.id);
  if (ids.length === 0) return { ok: false };
  const done = await withDeadlockRetry(() =>
    withNodeDeleteHeads(ids, (tx) =>
      tx
        .delete(nodes)
        .where(and(where, inArray(nodes.id, ids)))
        .returning({ id: nodes.id }),
    ),
  );
  return { ok: done.length > 0 };
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
    // Heads first (workspaces plan U1): the folder it lands in, shared.
    await withDeadlockRetry(() =>
      withNodeInsertHeads(ownerId, [{ type: 'branch', path: prefix }], async (tx) => {
        await tx
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
      }),
    );
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
  // A read-only snapshot copy keeps its name (W6b fix round 1).
  assertNotSnapshotCopy(node);
  // A folded member file (W6b): its bytes are named by its id, not its name,
  // so the disk does not refuse a name another file in the folder has. Its
  // name stays unique there, ignoring case (fix round 1, H1); and a tree
  // file does not take a folded file's name either.
  const taken = await fileNameTaken(args.ownerId, node.path, newFilename);
  if (taken && taken.id !== node.id && (taken.folded || foldedFilePath(node))) {
    throw new ConflictError(`renameFile: '${newFilename}' already exists in this folder`);
  }
  // A3b part 2 (store-broker.ts flipThenPlace): the row first, the checked
  // statement (exactly one row, else a refusal with the disk untouched),
  // then the rename on disk as the transaction's last step; a flip that
  // never landed puts the name back. It used to rename the disk first, so a
  // rename the database refused had already moved the file.
  const onDisk = !foldedFilePath(node);
  const updated = await flipThenPlace({
    flip: (place) =>
      withDeadlockRetry(() =>
        withHeads([node.id], 'update', (tx) =>
          inFlipTransaction(async () => {
            const rows = await tx
              .update(nodes)
              .set({
                title: newFilename,
                slug: newFilename,
                data: { ...data, filename: newFilename },
                updatedAt: new Date(),
              })
              .where(eq(nodes.id, node.id))
              .returning();
            const written = oneRow('files', rows, 'file');
            // A new name re-embeds (the kind registry's `indexed`): the
            // vector from the name and the summary it keeps, no model call;
            // a name-only file re-runs its spine, no model either.
            const u =
              (await markContentChanged(
                tx,
                { id: node.id, type: 'file' },
                changedFields({ title: [node.title, newFilename] }),
              )) ?? written;
            if (onDisk) await place();
            return u;
          }),
        ),
      ),
    place: async () => {
      await renameFileOnDisk(node.path, oldFilename, newFilename);
    },
    unplace: async () => {
      await renameFileOnDisk(node.path, newFilename, oldFilename);
    },
    settle: async () => (await rowNow(node.id)).filename === newFilename,
  });
  return fileRowFromNode(updated);
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

/** A file name a caller may not write over: a file it cannot read, or one
 *  it may read but not change (W6b fix round 1, H3). */
/** A ConflictError (A10 part 2): 409 and its message by the one domain
 *  error table, as the upload route answered `already exists` by hand. */
export class FileNameTakenError extends ConflictError {
  constructor(filename: string) {
    super(`writeFile: '${filename}' already exists in this folder`);
    this.name = 'FileNameTakenError';
  }
}

/**
 * Whether a file in `parentPath` has `filename` (ignoring case), asked
 * whatever the caller's scope: its id, whether it is a folded member file
 * and whether its name is exactly `filename`, never its content
 * (structure). The exact match first, then a tree file before a folded one.
 * By its definer (mantle_file_name_taken, 0293; A6b: on the system pool
 * before, 'name-taken').
 */
export async function fileNameTaken(
  ownerId: string,
  parentPath: string,
  filename: string,
): Promise<{ id: string; folded: boolean; exact: boolean } | null> {
  const rows = (await db.execute(
    sql`select id::text as id, folded, exact
          from "public"."mantle_file_name_taken"(${ownerId}::uuid, ${parentPath}, ${filename})`,
  )) as unknown as { id: string; folded: boolean; exact: boolean }[];
  return rows[0] ?? null;
}

/**
 * Run `fn` in the caller's workspace scope: the one it is in (a member's
 * request, a turn), else an Admin user's write request's (its writes run on
 * the system pool, checked against its scope: requestWriteScope). Undefined
 * for the system itself (no login to check).
 */
async function inCallerScope<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (!isSystemScope()) return fn();
  const loginId = requestWriteScope()?.loginId;
  return loginId ? withViewer({ login: loginId }, fn) : undefined;
}

/** Whether the caller reads item `id` (in its scope; null for the system). */
export async function callerSeesNode(id: string): Promise<boolean | null> {
  const seen = await inCallerScope(async () => {
    const rows = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).limit(1);
    return rows.length > 0;
  });
  return seen ?? null;
}

/** Whether the caller's scope may change item `id` (mantle_may_edit, not a
 *  snapshot copy). Asked in the caller's scope: false when it cannot read it. */
async function mayEditNode(id: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select ${mayEditSql('n')}
           and not coalesce(n.data ? 'snapshot_of', false) as edit
      from nodes n where n.id = ${id}`)) as unknown as { edit: boolean }[];
  return rows[0]?.edit === true;
}

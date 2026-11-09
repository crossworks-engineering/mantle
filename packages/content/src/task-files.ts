/**
 * Files on tasks (owner, 2026-11-09; plan page 74b70ac6). A task can hold a
 * few uploaded files: screenshots, logs, PDFs.
 *
 * KISS, three rules:
 *  - **Storage.** A task file is a normal file node, in one Auto-filed
 *    system folder per task: `files/auto-filed/task-files/task-<task id>/`.
 *    Same upload path, same bytes, same storage as every file.
 *  - **The link is the folder.** The task's files are the files in its
 *    folder. No column, no field, no migration. A file moved out of the
 *    folder is no longer on the task.
 *  - **The task's right is the one rule.** Read the task: list and open its
 *    files. Edit the task: add or remove one. Manage the task (its delete):
 *    the files go with it. The folder is the brain's (Auto-filed), so the
 *    file work runs as the named system step 'task-files', after the task's
 *    check in the caller's scope. The file's own grants are not asked here.
 *
 * Caps: 10 MB per file, 5 files per task, a fixed list of types
 * (@mantle/client-types/task-files). Stored by name only (`indexing:
 * 'metadata'`): no parser or vision model runs on an upload.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, nodes, systemStep } from '@mantle/db';
import {
  autoFiledFolderPath,
  deleteFileById,
  deleteFolder,
  discardSpooled,
  ensureAutoFiledFolder,
  extOf,
  fileNameTaken,
  folderByPath,
  mimeForExt,
  readFileById,
  sanitizeFilename,
  upsertFile,
  type FileRow,
  type SpooledUpload,
} from '@mantle/files';
import {
  TASK_FILE_EXTS,
  TASK_FILE_MAX_BYTES,
  TASK_FILES_MAX,
  isTaskFileType,
} from '@mantle/client-types/task-files';
import type { TaskFile } from '@mantle/client-types';
import { InputError } from '@mantle/std';

export { TASK_FILE_EXTS, TASK_FILE_MAX_BYTES, TASK_FILES_MAX, isTaskFileType };
export type { TaskFile };

/** The folder slug of a task's files: from its id, so a rename moves nothing. */
const folderSlug = (taskId: string) => `task-${taskId.toLowerCase()}`;

/** The ltree path of a task's files folder (made on the first upload). */
export function taskFilesPath(taskId: string): string {
  return autoFiledFolderPath('task-files', { document: { slug: folderSlug(taskId) } });
}

function taskFileOf(
  row: Pick<FileRow, 'id' | 'filename' | 'mimeType' | 'sizeBytes' | 'createdAt'>,
): TaskFile {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/** The task row, as the system reads it: null when no task has the id. */
async function taskOf(
  ownerId: string,
  taskId: string,
): Promise<{ id: string; title: string } | null> {
  const [row] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  return row ?? null;
}

/** The file nodes in a task's folder, oldest first (the system's read). */
async function filesInFolder(ownerId: string, taskId: string): Promise<TaskFile[]> {
  const rows = await db
    .select({ id: nodes.id, data: nodes.data, createdAt: nodes.createdAt })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path} = ${taskFilesPath(taskId)}::ltree`,
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const filename = String(d.filename ?? '');
    return {
      id: r.id,
      filename,
      // As the files store reads them (fileRowFromNode).
      mimeType: typeof d.mime_type === 'string' ? d.mime_type : mimeForExt(extOf(filename)),
      sizeBytes: Number(d.size_bytes ?? 0),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Is `fileId` a file in the task's folder? (the system's read) */
async function inTaskFolder(ownerId: string, taskId: string, fileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.id, fileId),
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path} = ${taskFilesPath(taskId)}::ltree`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The task's files, for a caller that reads the task. Throws the item
 * check's refusal (404) for a task the caller does not read.
 */
export async function listTaskFiles(ownerId: string, taskId: string): Promise<TaskFile[]> {
  return systemStep('task-files', { items: [taskId], need: 'read' }, async () => {
    if (!(await taskOf(ownerId, taskId))) return [];
    return filesInFolder(ownerId, taskId);
  });
}

/** A task row with its files, for the one-task read (the route's GET and
 *  task_get). A list never carries them. */
export async function withTaskFiles<T extends { id: string }>(
  ownerId: string,
  task: T,
): Promise<T & { files: TaskFile[] }> {
  return { ...task, files: await listTaskFiles(ownerId, task.id) };
}

/** Why a file may not go on a task, or null when it may. Pure: the route
 *  and the tool ask it before anything is read or written. */
export function taskFileRefusal(filename: string, sizeBytes: number): string | null {
  if (!isTaskFileType(filename)) {
    return `A task takes only these file types: ${TASK_FILE_EXTS.join(', ')}.`;
  }
  if (sizeBytes <= 0) return 'The file is empty.';
  if (sizeBytes > TASK_FILE_MAX_BYTES) {
    return `A task file can be at most ${TASK_FILE_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/** A free name in the folder: `name.ext`, else `name-2.ext`, `name-3.ext`.
 *  A pasted screenshot is always `image.png`, so this is the common case. */
async function freeName(ownerId: string, path: string, filename: string): Promise<string> {
  const clean = sanitizeFilename(filename);
  if (!clean) throw new InputError('The file name is not valid.');
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  // TASK_FILES_MAX + 1 tries: the folder holds at most that many names.
  for (let n = 1; n <= TASK_FILES_MAX + 1; n++) {
    const name = n === 1 ? clean : `${stem}-${n}${ext}`;
    if (!(await fileNameTaken(ownerId, path, name))) return name;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Put one file on a task, for a caller that may edit the task. Exactly one
 * of `bytes` (MCP, a JSON body) or `spooled` (the streamed upload). A
 * spooled upload is discarded on every refusal. Refused (InputError, 400):
 * a type off the list, an empty file, a file over 10 MB, a sixth file.
 * Null when no task has the id.
 */
export async function addTaskFile(args: {
  ownerId: string;
  taskId: string;
  filename: string;
  bytes?: Buffer;
  spooled?: SpooledUpload;
}): Promise<TaskFile | null> {
  const { ownerId, taskId } = args;
  try {
    const size = args.bytes ? args.bytes.byteLength : (args.spooled?.size ?? 0);
    const refusal = taskFileRefusal(args.filename, size);
    if (refusal) throw new InputError(refusal);
    return await systemStep('task-files', { items: [taskId], need: 'edit' }, async () => {
      const task = await taskOf(ownerId, taskId);
      if (!task) return null;
      const have = await filesInFolder(ownerId, taskId);
      if (have.length >= TASK_FILES_MAX) {
        throw new InputError(`A task holds at most ${TASK_FILES_MAX} files. Remove one first.`);
      }
      const parentPath = await ensureAutoFiledFolder(ownerId, 'task-files', {
        document: { slug: folderSlug(taskId), title: task.title },
      });
      const filename = await freeName(ownerId, parentPath, args.filename);
      const row = await upsertFile({
        ownerId,
        parentPath,
        filename,
        ...(args.bytes ? { bytes: args.bytes } : { spooled: args.spooled }),
        overwrite: false,
        // By name only: no parser or vision model runs on a task file.
        data: { indexing: 'metadata' },
      });
      return taskFileOf(row);
    });
  } finally {
    // No-op once adopted (upsertFile renamed it in); the safety net for
    // every refusal before that.
    if (args.spooled) await discardSpooled(args.spooled);
  }
}

/** A task file's bytes, for a caller that reads the task (the route's GET,
 *  task_file_get). Null when the file is not in the task's folder, or no task
 *  has the id. At most 10 MB, so the bytes are read whole. */
export async function readTaskFile(
  ownerId: string,
  taskId: string,
  fileId: string,
): Promise<{ row: FileRow; bytes: Buffer } | null> {
  return systemStep('task-files', { items: [taskId], need: 'read' }, async () => {
    if (!(await taskOf(ownerId, taskId))) return null;
    if (!(await inTaskFolder(ownerId, taskId, fileId))) return null;
    const res = await readFileById({ ownerId, fileId });
    return res ? { row: res.row, bytes: res.bytes } : null;
  });
}

/** Delete the files in a task's folder, then the folder (the system's work). */
async function deleteFolderFiles(ownerId: string, taskId: string, only?: string): Promise<number> {
  const files = await filesInFolder(ownerId, taskId);
  let deleted = 0;
  for (const f of files) {
    if (only && f.id !== only) continue;
    const res = await deleteFileById({ ownerId, fileId: f.id, deleteDerived: true });
    if (res.ok) deleted++;
  }
  // The folder goes once it is empty; deleteFolder refuses one that is not.
  if (deleted === files.length) {
    const folder = await folderByPath({ ownerId, path: taskFilesPath(taskId) });
    if (folder) {
      try {
        await deleteFolder({ ownerId, folderId: folder.id, allowSystem: true });
      } catch {
        // Best effort: an empty folder left behind is cosmetic, never data loss.
      }
    }
  }
  return deleted;
}

/**
 * Take one file off a task, for a caller that may edit the task. The file
 * is deleted. False when it is not in the task's folder.
 */
export async function removeTaskFile(
  ownerId: string,
  taskId: string,
  fileId: string,
): Promise<boolean> {
  return systemStep('task-files', { items: [taskId], need: 'edit' }, async () => {
    if (!(await taskOf(ownerId, taskId))) return false;
    if (!(await inTaskFolder(ownerId, taskId, fileId))) return false;
    return (await deleteFolderFiles(ownerId, taskId, fileId)) === 1;
  });
}

/**
 * Delete every file on a task, with its folder: the task delete's step,
 * for a caller that may manage the task (the delete's own right). The count
 * deleted.
 */
export async function deleteTaskFiles(ownerId: string, taskId: string): Promise<number> {
  return systemStep('task-files', { items: [taskId], need: 'manage' }, () =>
    deleteFolderFiles(ownerId, taskId),
  );
}

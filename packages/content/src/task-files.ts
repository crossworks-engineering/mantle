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
import { db, itemHomeSql, nodes, systemStep, withCreateHome } from '@mantle/db';
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
import { ConflictError, InputError } from '@mantle/std';

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
): Promise<{ id: string; title: string; home: string | null } | null> {
  const [row] = await db
    .select({ id: nodes.id, title: nodes.title, home: itemHomeSql() })
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
 * The one door of every task file act: the task's right (`need`) in the
 * caller's scope, then `fn` as the named system step 'task-files' (the
 * folder is Auto-filed's, which the caller's scope does not edit). `fn`
 * runs only for a task that exists, and gets it. One door for the five
 * acts, so the code leaves the scope at one place.
 */
async function taskFilesDoor<T>(
  need: 'read' | 'edit' | 'manage',
  ownerId: string,
  taskId: string,
  none: T,
  fn: (task: { id: string; title: string; home: string | null }) => Promise<T>,
): Promise<T> {
  return systemStep('task-files', { items: [taskId], need }, async () => {
    const task = await taskOf(ownerId, taskId);
    return task ? fn(task) : none;
  });
}

/**
 * The task's files, for a caller that reads the task. Throws the item
 * check's refusal (404) for a task the caller does not read.
 */
export async function listTaskFiles(ownerId: string, taskId: string): Promise<TaskFile[]> {
  return taskFilesDoor('read', ownerId, taskId, [] as TaskFile[], () =>
    filesInFolder(ownerId, taskId),
  );
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
    return await taskFilesDoor('edit', ownerId, taskId, null, async (task) => {
      const have = await filesInFolder(ownerId, taskId);
      if (have.length >= TASK_FILES_MAX) {
        throw new InputError(`A task holds at most ${TASK_FILES_MAX} files. Remove one first.`);
      }
      const parentPath = await ensureAutoFiledFolder(ownerId, 'task-files', {
        document: { slug: folderSlug(taskId), title: task.title },
      });
      const filename = await freeName(ownerId, parentPath, args.filename);
      // The file takes the task's home, as a part takes its file's
      // (part-of-file.ts), so the task's workspace holds it. Admin holds it
      // too, through the Auto-filed folder: an accepted risk under the
      // trusted-logins rule (docs/agent-ui.md).
      const create = () =>
        upsertFile({
          ownerId,
          parentPath,
          filename,
          ...(args.bytes ? { bytes: args.bytes } : { spooled: args.spooled }),
          overwrite: false,
          // By name only: no parser or vision model runs on a task file.
          data: { indexing: 'metadata' },
        });
      const row = task.home
        ? await withCreateHome({ createWs: task.home, privateWs: null }, create)
        : await create();
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
  return taskFilesDoor('read', ownerId, taskId, null, async () => {
    if (!(await inTaskFolder(ownerId, taskId, fileId))) return null;
    const res = await readFileById({ ownerId, fileId });
    return res ? { row: res.row, bytes: res.bytes } : null;
  });
}

/** Why the files store kept a file (deleteFileById's refusal), in words. */
function keptReason(
  filename: string,
  res: { reason?: string; drawings?: { title: string }[] },
): string {
  if (res.reason === 'in_drawing') {
    const where = (res.drawings ?? []).map((d) => d.title).join(', ') || 'a drawing';
    return `${filename} is used in ${where}. Take it out of the drawing first.`;
  }
  if (res.reason === 'has_derived') {
    return `${filename} has items made from it. Delete it in Files first.`;
  }
  if (res.reason === 'attachment') return `${filename} is attached to an email.`;
  return `${filename} could not be deleted.`;
}

/**
 * Delete the files in a task's folder (or the one file `only`), then the
 * folder once it is empty (the system's work). A file the files store
 * keeps (placed in a drawing, items made from it) is a ConflictError (409)
 * that says why, after the others went: never a task gone with a file left.
 * Derived items are not deleted here: a task file is stored by name only,
 * and one a person turned to full indexing keeps its items until they go.
 */
async function deleteFolderFiles(ownerId: string, taskId: string, only?: string): Promise<number> {
  const files = await filesInFolder(ownerId, taskId);
  let deleted = 0;
  const kept: string[] = [];
  for (const f of files) {
    if (only && f.id !== only) continue;
    const res = await deleteFileById({ ownerId, fileId: f.id });
    if (res.ok) deleted++;
    else kept.push(keptReason(f.filename, res));
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
  if (kept.length > 0) throw new ConflictError(kept.join(' '));
  return deleted;
}

/**
 * Take one file off a task, for a caller that may edit the task. The file
 * is deleted. False when it is not in the task's folder; a 409 that says
 * why when the files store keeps it.
 */
export async function removeTaskFile(
  ownerId: string,
  taskId: string,
  fileId: string,
): Promise<boolean> {
  return taskFilesDoor('edit', ownerId, taskId, false, async () => {
    if (!(await inTaskFolder(ownerId, taskId, fileId))) return false;
    return (await deleteFolderFiles(ownerId, taskId, fileId)) === 1;
  });
}

/**
 * Delete every file on a task, with its folder: the task delete's step,
 * for a caller that may manage the task (the delete's own right). The count
 * deleted. A file the store keeps is a 409 that says why, and the task
 * stays (deleteTask deletes the row after this).
 */
export async function deleteTaskFiles(ownerId: string, taskId: string): Promise<number> {
  return taskFilesDoor('manage', ownerId, taskId, 0, () => deleteFolderFiles(ownerId, taskId));
}
